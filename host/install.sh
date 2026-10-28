#!/bin/sh
# Registers host/codex_host.py with Google Chrome so the extension can run `codex exec`.
# Re-run after editing codex_host.py or switching Node versions (the wrapper pins node's path).
# Usage: host/install.sh [NativeMessagingHosts dir]   (default: Google Chrome's, for this user)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CODEX="$(command -v codex)" || { echo "codex not found on PATH" >&2; exit 1; }
# Apple's python, not Homebrew's: Chrome makes the host its own "responsible process" for
# macOS privacy checks, and under Homebrew's Python.app codex hangs at startup.
PYTHON=/usr/bin/python3
"$PYTHON" -c 'import sys; assert sys.version_info >= (3, 8)' || { echo "need /usr/bin/python3 (Xcode Command Line Tools)" >&2; exit 1; }
NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
TARGET="${1:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
EXTENSION_ID=cdaieplelnbooonfgjjnipgkmpblfjml  # fixed by "key" in manifest.json
# The host runs from a copy outside this folder: Chrome makes it its own responsible process, so
# it has no access to ~/Documents, ~/Desktop or ~/Downloads, where this folder may live.
HOST_DIR="$HOME/Library/Application Support/review-auto-decline"
mkdir -p "$HOST_DIR"
cp "$DIR/codex_host.py" "$HOST_DIR/"

# Chrome starts hosts with a bare PATH, so the wrapper supplies codex's and node's. sh stays
# the parent (the setup tested under Chrome's launch conditions) and passes Chrome's stop
# signal on to the python host, which then kills codex.
cat > "$HOST_DIR/codex-host" <<EOF
#!/bin/sh
PATH="$(dirname "$CODEX"):$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
exec 2>>"\$HOME/Library/Logs/review-auto-decline-host.log"  # startup errors and tracebacks
exec 3<&0  # a backgrounded command would otherwise get /dev/null instead of Chrome's stdin
"$PYTHON" -I "$HOST_DIR/codex_host.py" <&3 3<&- &
child=\$!
trap 'kill -TERM \$child 2>/dev/null' TERM INT
wait \$child
EOF
chmod +x "$HOST_DIR/codex-host"

mkdir -p "$TARGET"
cat > "$TARGET/local.review_auto_decline.json" <<EOF
{
  "name": "local.review_auto_decline",
  "description": "Runs codex exec for the Review Auto Decline extension",
  "path": "$HOST_DIR/codex-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
echo "Installed $TARGET/local.review_auto_decline.json -> $HOST_DIR/codex-host"
