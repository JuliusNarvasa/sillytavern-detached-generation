# AGENTS.md — installing Detached Generation (agent instructions)

These are instructions for an **AI agent or automated installer**. They are precise,
ordered and verifiable. Follow them in order. Do not guess paths — detect them.

## What you are installing

Two halves of one feature:

| Half | What it is | Where it goes |
|---|---|---|
| Browser half | SillyTavern UI extension (this repo's root: `manifest.json`, `extension.js`, `style.css`) | `<ST>/data/<user>/extensions/detached-gen/` (per user) or `<ST>/public/scripts/extensions/third-party/detached-gen/` (global) |
| Server half | SillyTavern server plugin (`server-plugin/`) | `<ST>/plugins/detached/` or `<ST>/plugins/detached-gen/` |

Both are required. The browser half alone does nothing useful (it falls back to normal
browser-side generation); the server half alone is invisible to the user.

> The browser entry file is named `extension.js`, **not** `index.js`: the server-plugin
> loader scans a plugin directory for `index.js`, and the repository root is also the
> browser extension. Keeping the names apart stops the loader from importing the browser
> bundle as a server plugin.

## Prerequisites

- SillyTavern **1.19.0+** (server plugins were added in 1.19). Check
  `<ST>/package.json` → `version`.
- Write access to `<ST>/plugins/`, `<ST>/config.yaml` and the ST data directory.
- Node.js as used by the ST instance.

## Step 1 — locate the SillyTavern installation

The directory contains `server.js`, `src/`, `plugins/`, `public/`, `config.yaml`.

```bash
# common locations
ls -d /path/to/SillyTavern                # explicit
ls -d /home/*/SillyTavern /opt/SillyTavern /srv/SillyTavern 2>/dev/null
# or from a running instance
ps aux | grep '[s]erver.js'
```

If ST runs in Docker, the host path may differ from the container path — work **inside**
the container (or bind-mount `plugins/` and the data dir).

## Step 2 — install the server plugin

Either copy it:

```bash
cd <ST>
cp -r <repo>/server-plugin plugins/detached
```

or let SillyTavern clone the repository for you (the repository's `package.json` points
`main` at `server-plugin/index.js`, so the plugin loader finds it):

```bash
cd <ST>
node plugins.js install https://github.com/JuliusNarvasa/detached-gen
```

(If `plugins/detached` already exists, back it up first: `mv plugins/detached plugins/detached.bak`.)

The plugin directory **must** contain `package.json` with `{"type": "module"}` — it is
already there in `server-plugin/`. Do not remove it; the plugin loader imports these files
as ES modules.

## Step 3 — enable server plugins

In `<ST>/config.yaml`:

```yaml
enableServerPlugins: true
```

If the key is missing, append it. Back the file up first
(`cp config.yaml config.yaml.bak-detached-gen`).

## Step 4 — restart the server

Server plugins are only loaded at boot. A restart is mandatory.

```bash
cd <ST> && npm start                      # foreground
# or, if systemd-managed:
sudo systemctl restart st.service
# docker:
docker restart sillytavern
```

## Step 5 — verify the server half

```bash
# the server log must mention the plugin
grep -i "server plugin(s) are currently loaded" <ST>/logs/st.log | tail -1
# or, systemd:
sudo journalctl -u st.service -n 100 --no-pager | grep -i "plugin"
```

Expected: `1 server plugin(s) are currently loaded.`

HTTP check (needs a session in a real deployment; use the port ST listens on):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/plugins/detached/status?jobId=probe
```

- `404` with a JSON body → the route exists (the plugin is loaded) ✅
- `403`/HTML → ST requires a login; that is expected for an authenticated instance
- connection refused → ST is not running or the port is wrong ❌

## Step 6 — install the browser half

Preferred (through the UI, no file copying): the user opens
**Extensions → Install extension** and pastes the repository URL:

```
https://github.com/JuliusNarvasa/detached-gen
```

then clicks **Install for all users** (admins) or **Install just for me**.

Automated alternative (this is exactly what ST's installer does):

```bash
git clone --depth 1 https://github.com/JuliusNarvasa/detached-gen <ST>/data/<user>/extensions/detached-gen
```

Rules:

- The target directory name **must be `detached-gen`** (ST derives it from the repo name).
- `manifest.json` **must be in the repository root** (ST's installer deletes the clone
  otherwise).

## Step 7 — verify the browser half

- Reload the SillyTavern page.
- The Extensions panel shows **Detached Generation** with a *Detached mode* checkbox.
- Enable it.
- If the server plugin is missing, a warning banner appears in the same panel — that means
  Steps 2–5 did not take effect.

## Step 8 — end-to-end check

1. Send a message in any chat.
2. While the reply is streaming, close the tab (or the whole browser).
3. Wait for the generation to finish.
4. Reopen SillyTavern and open the same chat.
5. The reply must appear — streamed in live if it was still running, inserted if finished.

Server-side proof without a browser:

```bash
ls <ST>/data/detached-jobs/<user>/            # job dirs
cat <ST>/data/detached-jobs/<user>/<jobId>/job.json   # {"state":"done", ...}
```

## Failure modes

| Symptom | Fix |
|---|---|
| `Failed to load plugin ... SyntaxError: Cannot use import statement outside a module` | `server-plugin/package.json` with `{"type":"module"}` is missing in the deployed copy |
| Plugin not listed in the log | `enableServerPlugins: true` missing, or the server was not restarted |
| `Directory already exists` when installing | Delete/rename `<ST>/data/<user>/extensions/detached-gen` first |
| Extension invisible in the UI | `manifest.json` is not in the repo root, or the folder name is not `detached-gen` |
| Generation still dies with the tab | Detached mode not enabled for that user, or the browser half is not loaded (check `window.fetch` is patched) |

## Do not

- Do not modify SillyTavern core files. The feature works without touching them.
- Do not remove the `server-plugin/` folder from the repository — it is the server half.
- Do not change the repository name: the folder name (`detached-gen`) and the SW/asset
  paths depend on it.

