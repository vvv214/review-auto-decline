"""Chrome native-messaging host for Review Auto Decline.

Chrome starts this script once per request: it reads one message
({prompt, schema, model}), runs one `codex exec` in a throwaway directory, and replies
with {ok, text} (the final message, shaped by the schema) or {ok: false, error}.
"""
import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import time

LOG = os.path.expanduser("~/Library/Logs/review-auto-decline-host.log")

# Email text is untrusted, so Codex runs sandboxed: no file reads outside the
# throwaway directory, no network, no web search, no plugins.
ISOLATION = [
    "-c", 'default_permissions="rad-isolated"',
    "-c", 'permissions.rad-isolated.extends=":workspace"',
    "-c", 'permissions.rad-isolated.filesystem={":root"="deny",":minimal"="read",":slash_tmp"="deny"}',
    "-c", "permissions.rad-isolated.network.enabled=false",
    "-c", 'web_search="disabled"',
]
ISOLATION += ["-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"']
for feature in ("apps", "hooks", "memories", "multi_agent", "plugin_sharing", "plugins",
                "remote_plugin", "skill_mcp_dependency_install", "skill_search"):
    ISOLATION += ["--disable", feature]
TIMEOUT_SEC = 240


def log(line):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()} {line}\n")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        sys.exit(0)
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


def fresh_codex_home(path):
    """A Codex home holding only a link to your login: no skills, plugins or MCP servers
    from ~/.codex, and no state database shared with your other Codex sessions."""
    real = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    os.symlink(os.path.join(real, "auth.json"), os.path.join(path, "auth.json"))
    return path


def run(req):
    # The home sits outside the workspace, so sandboxed commands can't read the login.
    with tempfile.TemporaryDirectory(prefix="rad-codex-") as work, \
         tempfile.TemporaryDirectory(prefix="rad-codex-home-") as home:
        schema = os.path.join(work, "schema.json")
        answer = os.path.join(work, "answer.json")
        with open(schema, "w") as f:
            json.dump(req["schema"], f)
        cmd = [
            "codex", "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
            "-C", work, "-m", req.get("model") or "gpt-6.1-sol",
            "-c", 'model_reasoning_effort="low"', *ISOLATION,
            "--output-schema", schema, "-o", answer, "-",
        ]
        start = time.time()
        errfile = open(os.path.join(work, "stderr.txt"), "w+b")
        proc = subprocess.Popen(
            cmd, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errfile,
            env={**os.environ, "TMPDIR": work, "CODEX_HOME": fresh_codex_home(home)}, start_new_session=True,
        )
        # If Chrome stops us (e.g. the extension reloads), take codex and its children along.
        def stop(signum, _frame):
            os.killpg(proc.pid, signal.SIGKILL)
            log(f"got signal {signum} after {time.time() - start:.0f}s; killed codex")
            sys.exit(1)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            proc.communicate(req["prompt"].encode(), timeout=TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            log(f"timeout after {TIMEOUT_SEC}s")
            return {"ok": False, "error": f"codex exec timed out after {TIMEOUT_SEC}s"}
        text = open(answer).read().strip() if os.path.exists(answer) else ""
        log(f"exit={proc.returncode} {time.time() - start:.0f}s answer={len(text)}B")
        if not text:
            errfile.seek(0)
            return {"ok": False, "error": f"codex exec exit {proc.returncode}: {errfile.read().decode(errors='replace')[-600:]}"}
        return {"ok": True, "text": text}


if __name__ == "__main__":
    try:
        req = read_message()
        log(f"request: model={req.get('model') or 'default'} prompt={len(req['prompt'])}B")
        send(run(req))
    except Exception as e:  # report instead of dying silently, which Chrome shows as a vague error
        send({"ok": False, "error": repr(e)})
