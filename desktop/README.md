# Paperclip desktop

Paperclip as a self-contained Mac app. The app starts the bundled Paperclip
server and its embedded Postgres as a child process, bound to `127.0.0.1` on a
free port, and shows the board UI in its own window. Nothing else needs to be
installed or started, and nothing listens beyond this Mac.

- **Data:** `~/Library/Application Support/Paperclip/` (`home/` is the Paperclip
  instance, `logs/server.log` the server log, `desktop-secrets.json` the
  per-install auth and signing secrets generated on first launch).
- **Closing the window** keeps agents working in the background; **Quit (⌘Q)**
  stops the server and the database.
- **Paperclip menu:** Restart Server, Open in Browser, Show Data Folder, Show
  Server Log.
- Telemetry and the announcements feed are turned off.
- Agent CLIs (`claude`, `codex`, `git`, …) are found through your login shell's
  `PATH`.

## Build

Requires the repo's toolchain (Node 24.11+, pnpm 9.15, Rust). From this folder:

```sh
npm install                 # Electron + electron-builder
npm start                   # run against the repo build (needs server/dist-runtime)
npm run stage               # pnpm build + server runtime bundle + production deps -> stage/
npx electron-builder --mac dir   # dist/mac-arm64/Paperclip.app
npm run dist:mac            # signed (not notarized) app + ZIP in dist/
npm run dist:mac:notarized  # adds a DMG and notarization, for distribution only
```

## Models from ModelControl

On each launch the app reads `desktop-settings.json` in the data folder (Paperclip
› Edit Model Settings…) and hands the listed ModelControl models to Paperclip's
OpenCode agents as `modelcontrol/<id>`. ModelControl must be running and Online
at `http://127.0.0.1:8800/v1`; context sizes come from its `/v1/models`
(8192 when it reports none). Restart the server after editing the file. Codex
agents can't use ModelControl until it serves `/v1/responses`.

`node scripts/stage.mjs --skip-build` re-stages from the existing build output.
The server runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), so the app
needs no separate Node install.
