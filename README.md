# Review Auto Decline

[中文说明](README.zh-CN.md)

A Chrome extension for Outlook on the web that declines every journal peer-review invitation sent to you. It finishes the decline on the journal's site in a background tab, then deletes the invitation, the review system's registration email and the "you declined" confirmation email.

It is for people who have decided to stop reviewing for journals altogether: there is no allow list, and every invitation addressed to you gets declined.

## Install

1. Download `review-auto-decline-*.zip` from [Releases](https://github.com/vvv214/review-auto-decline/releases) and unzip it somewhere permanent, or `git clone` this repository. Chrome loads the extension from that folder every time it starts, so don't delete or move it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and select the folder. The extension ID is always `cdaieplelnbooonfgjjnipgkmpblfjml` (fixed by the `key` in `manifest.json`).
3. The settings page opens. Choose the LLM for emails and pages the built-in rules don't recognize (see below), add any other names or addresses invitations may be sent to, and click **Save**. **Test LLM** asks the chosen LLM about a made-up IEEE Access invitation and shows the answer and how long it took.

Clicking the extension's toolbar icon opens the settings page and the log of recent actions.

### Choosing the LLM

- **Codex (default)**: runs `codex exec` on your machine through a Chrome native-messaging host. It needs macOS, Google Chrome, the [Codex CLI](https://github.com/openai/codex) logged in, Node and `/usr/bin/python3` (Xcode Command Line Tools). Run `host/install.sh` once. Run it again after editing `host/codex_host.py` or switching Node versions (for example with nvm). The default model is `gpt-6.1-sol` with low effort, about 6–8 seconds per call; you can change the model on the settings page.
- **Anthropic API**: calls Claude directly from the extension with your API key (Claude Opus 5.5, Sonnet 5.5 or Haiku 5.5). The key is stored unencrypted in the extension's local storage.
- **Off**: built-in rules only. Editorial Manager and ScholarOne invitations are still handled.

## What it does

While Outlook on the web (outlook.cloud.microsoft, outlook.office.com or outlook.office365.com) is open in Chrome, it opens each review-related email that arrived **after you installed it**, once:

| Email | What happens |
| --- | --- |
| Review invitation addressed to you (you are on the To line) | Opens the decline link in a background tab, clicks submit/confirm, closes the tab once the site confirms, and moves the invitation to Deleted Items |
| Registration or account-created email from a submission system | Moved to Deleted Items |
| "You declined" / "thank you for responding" confirmation | Moved to Deleted Items |
| Anything else (students, conference PC invitations, copies of invitations sent to other reviewers that you are cc'd on as an editor, …) | Left alone; marked unread again if it was unread |

Built-in rules come first: they cover the Editorial Manager and ScholarOne formats. The ScholarOne confirmation page and "declined" email were checked against real IEEE Access ones. When the rules don't recognize an email, the LLM says what it is and which link declines it. When a decline page looks different, the LLM picks the next thing to click or select.

## Safety

- Only invitations with you on the To line are declined. A copy of an invitation sent to another reviewer, with you on Cc as the editor, is never touched. Your Outlook display name always counts as you; add your other addresses on the settings page.
- It never clicks agree, accept, log in, register, "remove my information" or similar, and never types into password fields. The only text it ever types is the fixed sentence "I am unable to review this manuscript at this time.", so text on a page can't make it type anything else.
- Codex runs sandboxed: it can't read files outside its throwaway directory, has no network, web search, plugins or memories, and uses a temporary Codex home that holds only a link to `auth.json`. Instructions planted in an email or web page can't reach anything on your computer.
- When a page isn't recognized, wants a login, or the decline isn't done after 6 steps, the tab is left open. The toolbar icon shows a red "!" and the settings page logs why.
- "Are you sure?" dialogs are accepted automatically, but only in tabs the extension opened itself.
- Every deletion is a move to Deleted Items, so you can get the email back.
- It pauses while you're using that Outlook tab (mouse or keyboard input in the last 30 seconds, or typing), so it doesn't switch away from the email you're reading.

## What is sent to the LLM

For each email, only these are sent:
- the message-list line (sender, subject, preview)
- the sender address and the From, To and Cc lines
- the first 800 characters of the body
- 200 characters around each link (the link text, not its address)

For decline pages, it sends the page text and the page's buttons and fields. It never sends a whole manuscript abstract.

## Limitations

- It only works with Outlook on the web in English, because it finds Outlook's controls by their English labels ("To:", "Delete", "Mark as unread").
- It only works while an Outlook tab is open in Chrome. Emails that arrived before you installed it are never touched.
- The Codex backend only works on macOS with Google Chrome.

## Troubleshooting the Codex host

- On the settings page, click **Test LLM**. "Works" means the host is set up. "Native host has exited" with no `request:` line in the log means the host didn't start: run `host/install.sh` again. Opening `chrome-extension://cdaieplelnbooonfgjjnipgkmpblfjml/options.html#test` runs the test automatically.
- Every call writes two lines to `~/Library/Logs/review-auto-decline-host.log`: one when the request arrives, and one with the time taken, the exit code and whether an answer came back. Host startup errors go there too.
- The host runs from a copy in `~/Library/Application Support/review-auto-decline/`. For macOS privacy checks, Chrome makes the host its own "responsible process", so the host can't read `~/Documents`, `~/Desktop` or `~/Downloads`, where this folder may live.
- The host uses Apple's `/usr/bin/python3`, not Homebrew's. Under Homebrew's Python.app, `codex exec` hangs at startup when Chrome starts it.
- A call that takes longer than 240 seconds is killed, and the email is tried again later (up to 3 times).

## Development

After changing the code, click the extension's reload button in `chrome://extensions`, or open `chrome-extension://cdaieplelnbooonfgjjnipgkmpblfjml/options.html#reload`. Outlook tabs that are already open get the new script without a refresh.

`test/e2e.mjs` loads the extension in headless Chromium with a mock Outlook page and mock journal sites. It checks declining, deleting, skipping cc'd copies and restoring unread state, without touching real accounts:

```bash
cd test && npm install && npx playwright install chromium
node e2e.mjs ..         # rules only
node e2e.mjs .. llm     # Anthropic backend, with the Claude API mocked
node e2e.mjs .. codex   # real codex exec through the native host, registered only in the test's throwaway profile
```

| File | Role |
| --- | --- |
| `outlook.js` | Content script in Outlook: finds, opens, reads and deletes emails |
| `background.js` | Decides what each email is and drives the decline tabs |
| `rules.js` | Fixed rules for Editorial Manager and ScholarOne |
| `llm.js` | Prompts and JSON schemas for the LLM; the Codex and Claude backends |
| `host/codex_host.py`, `host/install.sh` | The native-messaging host, which runs one `codex exec` per request, and its installer |
| `lib/anthropic.mjs` | The official Anthropic JS SDK 1.3.0, bundled with esbuild ([Apache-2.0](lib/LICENSE-anthropic-sdk.txt)) |
| `options.html`, `options.js` | Settings page and action log |

## License

[MIT](LICENSE). `lib/anthropic.mjs` is the Anthropic SDK, under the Apache License 2.0.
