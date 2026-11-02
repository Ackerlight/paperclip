// Paperclip desktop shell.
//
// Runs the bundled Paperclip server (with its embedded Postgres) as a child
// process of this app, bound to 127.0.0.1 on a free port, and shows the board
// UI in an app window. Quitting the app stops the server and the database.

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HEALTH_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

// Packaged: Resources/paperclip (staged by scripts/stage.mjs).
// Unpackaged (`npm start`): the repo checkout this folder lives in.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "paperclip")
  : path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "server", "dist-runtime", "index.mjs");

const DATA_DIR = app.getPath("userData");
const PAPERCLIP_HOME = path.join(DATA_DIR, "home");
const LOG_DIR = path.join(DATA_DIR, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.log");
const SECRETS_FILE = path.join(DATA_DIR, "desktop-secrets.json");
const SETTINGS_FILE = path.join(DATA_DIR, "desktop-settings.json");

// ModelControl (local hub at :8800) serves local GGUF and OpenRouter models over an
// OpenAI-compatible API. Its tool-capable starter set; edit desktop-settings.json to change.
const DEFAULT_SETTINGS = {
  modelControl: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8800/v1",
    // Empty while ModelControl's require_token_local is off; otherwise an mcc_ client grant.
    token: "",
    models: [
      "qwen3-coder-30b-a3b-instruct-q4_k_m",
      "qwen2.5-coder:14b",
      "gpt-oss-20b-mxfp4",
      "openrouter/anthropic/claude-sonnet-4.5",
    ],
  },
};
// ModelControl serves models whose native window it could not parse at this size.
const MODELCONTROL_DEFAULT_CONTEXT = 8192;

let mainWindow = null;
let server = null;
let serverUrl = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);
}

// One-time secrets that `paperclipai onboard` would otherwise create. Stored
// readable only by this user and passed to the server through its environment.
function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    const make = () => crypto.randomBytes(32).toString("base64url");
    const secrets = {
      BETTER_AUTH_SECRET: make(),
      PAPERCLIP_AGENT_JWT_SECRET: make(),
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: make(),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return DEFAULT_SETTINGS;
  }
}

function fetchJson(url, headers, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

// OpenCode agents pick these up as "modelcontrol/<id>" (PAPERCLIP_OPENCODE_PROVIDERS).
// Context sizes come from ModelControl when it is running; otherwise its default.
async function modelControlEnv() {
  const mc = { ...DEFAULT_SETTINGS.modelControl, ...loadSettings().modelControl };
  if (!mc.enabled || !Array.isArray(mc.models) || mc.models.length === 0) return {};
  const baseUrl = mc.baseUrl.replace(/\/+$/, "");
  const headers = mc.token ? { Authorization: `Bearer ${mc.token}` } : {};
  const catalog = await fetchJson(`${baseUrl}/models`, headers);
  const byId = new Map((catalog?.data ?? []).map((m) => [m.id, m]));
  const models = {};
  for (const id of mc.models) {
    const info = byId.get(id)?.modelcontrol ?? {};
    const context = info.context_length || MODELCONTROL_DEFAULT_CONTEXT;
    models[id] = {
      name: id,
      tool_call: true,
      limit: { context, output: Math.min(16384, Math.floor(context / 2)) },
    };
  }
  const options = { baseURL: baseUrl };
  if (mc.token) options.apiKey = mc.token;
  const provider = { npm: "@ai-sdk/openai-compatible", name: "ModelControl", options, models };
  return { PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ modelcontrol: provider }) };
}

// Apps opened from Finder get a bare PATH, so agent CLIs (claude, codex, git…)
// would not be found. Borrow the PATH from the user's login shell.
function loginShellPath() {
  try {
    const shellPath = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellPath, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/__PATH__(.*)__PATH__/);
    if (match && match[1]) return match[1];
  } catch {
    // Fall through to the inherited PATH.
  }
  return process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function serverEnv(port, extra) {
  const env = { ...process.env };
  // Never let a developer shell's settings point the app at another database or port.
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PORT", "HOST", "NODE_OPTIONS", "PAPERCLIP_CONFIG"]) {
    delete env[key];
  }
  return {
    ...env,
    ...loadSecrets(),
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PATH: loginShellPath(),
    HOST: "127.0.0.1",
    PORT: String(port),
    SERVE_UI: "true",
    PAPERCLIP_HOME,
    PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    ...extra,
  };
}

function setStatus(title, status, detail = "", isError = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const args = [title, status, detail, isError].map((v) => JSON.stringify(v)).join(",");
  mainWindow.webContents.executeJavaScript(`window.setStatus && window.setStatus(${args})`).catch(() => {});
}

function tailLog(lines = 40) {
  try {
    return fs.readFileSync(SERVER_LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, { timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        // The server answers 200 with status "starting" while migrations run.
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startServer() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Server bundle not found at ${SERVER_ENTRY}. Run "pnpm --filter @paperclipai/server build:runtime" first.`);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = fs.createWriteStream(SERVER_LOG, { flags: "a" });
  log.write(`\n===== ${new Date().toISOString()} starting Paperclip on ${url} =====\n`);

  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: serverEnv(port, await modelControlEnv()),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });

  let exited = null;
  server.once("exit", (code, signal) => {
    exited = { code, signal };
    log.write(`===== server exited code=${code} signal=${signal} =====\n`);
    server = null;
    if (!quitting) onServerCrashed(code, signal);
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The server stopped during startup (code ${exited.code ?? exited.signal}).`);
    if (await checkHealth(url)) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The server did not become ready in time.");
}

function onServerCrashed(code, signal) {
  if (!serverUrl) return; // Startup failures are reported by start().
  serverUrl = null;
  setStatus("Paperclip stopped", `The server exited unexpectedly (${code ?? signal}).`, tailLog(), true);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, "loading.html")).then(() =>
      setStatus("Paperclip stopped", `The server exited unexpectedly (${code ?? signal}). Use Paperclip › Restart Server to try again.`, tailLog(), true),
    );
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A server stopped while still starting up exits without stopping its embedded
// Postgres. Stop any postmaster still running on this app's data directory.
async function stopOrphanedPostgres() {
  const pidFile = path.join(PAPERCLIP_HOME, "instances", "default", "db", "postmaster.pid");
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").split("\n")[0], 10);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return;
  process.kill(pid, "SIGTERM"); // Postgres "smart" shutdown.
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (isAlive(pid)) process.kill(pid, "SIGQUIT"); // Immediate shutdown.
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    // SIGTERM lets the server drain runs and stop embedded Postgres cleanly.
    child.kill("SIGTERM");
  }).then(stopOrphanedPostgres);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Paperclip",
    backgroundColor: "#0a0a0b",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Keep the app window on the local server; send everything else to the browser.
  const isLocal = (target) => serverUrl && target.startsWith(serverUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: "allow" };
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || isLocal(url)) return;
    event.preventDefault();
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
  });

  // Closing the window keeps agents working in the background, like other Mac apps.
  mainWindow.on("close", (event) => {
    if (!quitting && process.platform === "darwin") {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function restartServer() {
  serverUrl = null;
  await stopServer();
  await mainWindow.loadFile(path.join(__dirname, "loading.html"));
  await boot();
}

async function boot() {
  setStatus("Starting Paperclip", "Starting the local server and database…");
  try {
    serverUrl = await startServer();
    await mainWindow.loadURL(serverUrl);
  } catch (error) {
    setStatus("Paperclip could not start", error.message, tailLog(), true);
  }
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Restart Server", click: () => restartServer() },
        { label: "Open in Browser", click: () => serverUrl && shell.openExternal(serverUrl) },
        { label: "Show Data Folder", click: () => shell.openPath(DATA_DIR) },
        { label: "Show Server Log", click: () => shell.openPath(SERVER_LOG) },
        { label: "Edit Model Settings…", click: () => (loadSettings(), shell.openPath(SETTINGS_FILE)) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Navigate",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => mainWindow?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => mainWindow?.webContents.navigationHistory.goForward() },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  buildMenu();
  await createWindow();
  await boot();
}

app.on("activate", () => showWindow());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopServer().finally(() => app.exit(0));
});

process.on("uncaughtException", (error) => {
  dialog.showErrorBox("Paperclip", String(error?.stack || error));
});
