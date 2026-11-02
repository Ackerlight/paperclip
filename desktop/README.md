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
npm run dist:mac            # signed DMG + ZIP in dist/
```

`node scripts/stage.mjs --skip-build` re-stages from the existing build output.
The server runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), so the app
needs no separate Node install.
