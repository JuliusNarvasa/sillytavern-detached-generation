# Detached Generation for SillyTavern

**Keep generating after you close the tab.**

SillyTavern runs the whole generation in your browser: the prompt is built client-side, the
request is streamed from the browser to the API, and the tokens only exist in the page's
memory. If the tab is closed, backgrounded by a mobile browser, or the connection drops,
**the generation dies and the partial output is lost**.

This extension moves the generation to the server:

- the browser hands the fully-assembled request to a server-side job,
- the server talks to your LLM API on its own socket and records every chunk,
- the browser can be closed, the phone can sleep, the Wi-Fi can drop,
- when you come back, the reply **streams into the chat live** and is saved normally.

Works with every backend (OpenAI-compatible, Kobold, text-completion, ...) because it
re-uses the request your client would have sent.

---

## Installation

### 1. Browser half — through the SillyTavern UI

1. Open **Extensions → Install extension**.
2. Paste the repository URL:
   `https://github.com/JuliusNarvasa/detached-gen`
3. Click **Install for all users** (admins) or **Install just for me**.

> The repository name must stay `detached-gen`: SillyTavern derives the extension folder
> name from the repository name.

### 2. Server half — one command

The generation itself has to run inside the SillyTavern process, so a small **server
plugin** is installed next to it:

```bash
cd /path/to/SillyTavern
bash install.sh            # or: bash install.sh /path/to/SillyTavern
```

This copies the plugin to `plugins/detached/`, sets `enableServerPlugins: true` in
`config.yaml` (keeping a backup) and prints the restart command.

<details>
<summary>Alternative: install it with SillyTavern's own plugin installer</summary>

```bash
cd /path/to/SillyTavern
node plugins.js install https://github.com/JuliusNarvasa/detached-gen
```

This clones the repository into `plugins/detached-gen/`; the plugin loader picks up
`server-plugin/index.js` through the repository's `package.json`. Remember to set
`enableServerPlugins: true` and restart.
</details>

<details>
<summary>Manual equivalent</summary>

```bash
cd /path/to/SillyTavern
cp -r server-plugin plugins/detached
# config.yaml: enableServerPlugins: true
# restart SillyTavern
```
</details>

Server plugins are only loaded at boot, so **SillyTavern has to be restarted** after this
step.

### 3. Switch it on

**Extensions → Detached Generation → enable "Detached mode"** (per user).

If the server half is missing, the extension shows a warning in the same panel instead of
failing silently.

---

## How to use it

Nothing changes. Send a message as usual — a toast confirms that the generation is
detached and that you may close the tab.

| You do this | What happens |
|---|---|
| Send a message, keep the tab open | Identical to stock SillyTavern: the reply streams in live |
| Send a message, close the tab | The generation continues on the server |
| Come back later | The reply is fetched and **streams into the chat live** from the recorded chunks |
| Come back after it finished | The finished message is inserted and saved |
| Press **Stop** | The server-side job is cancelled (this is the only thing that stops a job) |

Job artifacts are stored on the server under
`data/detached-jobs/<user>/<jobId>/` (`job.json`, `chunks.bin`, `result.json`) and pruned
after 24 hours.

---

## How it works

1. The extension patches `window.fetch`. A POST to `/api/backends/<backend>/generate` is
   redirected to the server plugin (`POST /api/plugins/detached/submit`) and answered with
   a job id.
2. The plugin re-issues the *identical* request to SillyTavern's own backend endpoint over
   **localhost**. SillyTavern's backends abort the upstream call when the incoming socket
   closes (`request.socket.on('close', () => controller.abort())`) — but that socket now
   belongs to the plugin, not to your browser. Closing the tab therefore cannot kill the
   generation.
3. Every SSE chunk is appended to disk.
4. While the browser is alive it consumes `/api/plugins/detached/stream`, which replays the
   recorded bytes (and keeps delivering new ones), so the stock streaming UI is used.
5. After a reload the extension re-enters SillyTavern's own `Generate()` flow with the
   recorded bytes, which is why the reply streams back in live.

---

## Requirements & limits

- SillyTavern **1.19.0 or newer** (the plugin uses the server-plugin API added in 1.19).
- `enableServerPlugins: true` and a server restart.
- **Prompt assembly still happens in the browser.** You can close the tab *after* sending
  the prompt, not before. Macros, lorebooks and presets are client-side code.
- Multi-step tool-call loops need a live client between the steps.
- Group chats and swipes are not covered by the automated tests.
- The server needs write access to its data directory (for the job files).

## Security

The plugin's routes are mounted under `/api/plugins/detached/` and inherit SillyTavern's
session authentication and CSRF protection. Jobs are scoped to the logged-in user, and the
upstream API keys are resolved by SillyTavern itself — the plugin never handles secrets.
Anyone who can talk to the SillyTavern server can already use its API.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "the server plugin is not installed" banner | Run `bash install.sh`, enable `enableServerPlugins`, restart |
| Generation still stops when the tab closes | Detached mode is off for that user, or the plugin is not loaded (check the server log for "server plugin(s) are currently loaded") |
| Reply appears only when finished | The job was already finished when you returned (nothing to stream) |
| "Detached submit failed, falling back" | The plugin route is unreachable — check the server log |

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with SillyTavern. Tested against SillyTavern 1.19.0 (commit `7e8663cd9`).

