# Paperclip desktop

Paperclip as a self-contained Mac app. The app starts the Paperclip server and
its embedded Postgres as a child process, bound to `127.0.0.1` on a free port,
and shows the board UI in its own window. Nothing else needs to be installed or
started, and nothing listens beyond this Mac.

The server is the official `paperclipai` npm release pinned by
`"paperclipRelease"` in `package.json`, not this fork's source build: esbuild
bakes the build machine's absolute paths into `server/dist-runtime`, so the
fork's bundle only runs next to its checkout. The published packages run from
anywhere.

- **Data:** `~/Library/Application Support/Paperclip/` (`home/` is the Paperclip
  instance, `logs/server.log` the server log, `desktop-secrets.json` the
  per-install auth and signing secrets generated on first launch,
  `desktop-settings.json` the model settings).
- **Closing the window** keeps agents working in the background; **Quit (⌘Q)**
  stops the server and the database.
- **Paperclip menu:** Restart Server, Open in Browser, Show Data Folder, Show
  Server Log, Edit Model Settings.
- Telemetry and the announcements feed are turned off.
- **Agents:** Claude Code and Codex agents use your existing `claude` / `codex`
  sign-ins (no API keys). The release's own agent CLIs come first on `PATH`,
  then your login shell's `PATH`.

## Build

Needs Node 24.11+ and npm. From this folder:

```sh
npm install                 # Electron + electron-builder
npm run stage               # npm install paperclipai@<paperclipRelease> -> stage/
npm start                   # run the staged release in a window
npx electron-builder --mac dir   # signed dist/mac-arm64/Paperclip.app
npm run dist:mac            # signed (not notarized) app + ZIP in dist/
npm run dist:mac:notarized  # adds a DMG and notarization, for distribution only
```

To move to a newer Paperclip release, change `"paperclipRelease"` (and
`"version"`) and re-stage. The server runs on Electron's own Node
(`ELECTRON_RUN_AS_NODE`), so the app needs no separate Node install.

## Models from ModelControl

On each launch the app reads `desktop-settings.json` and gives the listed
ModelControl models to Paperclip's OpenCode agents as `modelcontrol/<id>`,
through `OPENCODE_CONFIG_CONTENT` so they also appear in Paperclip's model
picker. ModelControl must be running and Online at `http://127.0.0.1:8800/v1`;
context sizes come from its `/v1/models` (8192 when it reports none). Restart
the server after editing the file.

- OpenCode's first request is ~11k tokens, so local models must be served with
  at least 32k context.
- Codex agents can't use ModelControl until it serves `/v1/responses`.
