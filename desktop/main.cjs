// Paperclip desktop shell.
//
// Runs the bundled Paperclip server (with its embedded Postgres) as a child
// process of this app, bound to 127.0.0.1 on a free port, and shows the board
// UI in an app window. Quitting the app stops the server and the database.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { createChatBridge } = require("./chat-bridge.cjs");
const { createWorkFolders } = require("./work-folders.cjs");

const HEALTH_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

// The official paperclipai npm release, staged by scripts/stage.mjs.
// Packaged: Resources/paperclip. Unpackaged (`npm start`): desktop/stage/paperclip.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "paperclip")
  : path.join(__dirname, "stage", "paperclip");
const SERVER_ENTRY = path.join(ROOT, "node_modules", "@paperclipai", "server", "dist", "index.js");

const DATA_DIR = app.getPath("userData");
const PAPERCLIP_HOME = path.join(DATA_DIR, "home");
const LOG_DIR = path.join(DATA_DIR, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.log");
const SECRETS_FILE = path.join(DATA_DIR, "desktop-secrets.json");
const SETTINGS_FILE = path.join(DATA_DIR, "desktop-settings.json");
const workFolders = createWorkFolders();
const WORK_SYNC_INTERVAL_MS = 60 * 1000;
let workSyncTimer = null;
let cleanupWindow = null;

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
  // Largest file a chat, comment or task attachment may be (Paperclip's own
  // default is 10 MB). Uploads are buffered in memory, so keep it sensible.
  attachmentMaxMB: 512,
  // Local port for the Claude Code chat bridge (chat-bridge.cjs).
  chatBridge: { port: 47821 },
};
// ModelControl serves models whose native window it could not parse at this size.
const MODELCONTROL_DEFAULT_CONTEXT = 8192;

const chatBridge = createChatBridge({
  port: Number(loadSettings().chatBridge?.port) || DEFAULT_SETTINGS.chatBridge.port,
  dataDir: DATA_DIR,
  getServerUrl: () => serverUrl,
  skillPath: path.join(ROOT, "node_modules", "@paperclipai", "server", "skills", "paperclip", "SKILL.md"),
  log: (line) => fs.appendFile(SERVER_LOG, `${line}\n`, () => {}),
});

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

// OpenCode agents pick these up as "modelcontrol/<id>". The provider goes in
// OPENCODE_CONFIG_CONTENT, which the opencode CLI merges into its config for
// both `opencode models` (Paperclip's model picker and pre-run availability
// check) and agent runs. Context sizes come from ModelControl when it is
// running; otherwise its default.
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
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { modelcontrol: provider } }) };
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
  // DO_NOT_TRACK reaches the agent CLIs: with it set, `claude setup-token` prints
  // a copy hint between the sign-in URL and the code prompt, and Paperclip's
  // parser then never finds the URL (browser sign-in hangs on "Preparing").
  // PAPERCLIP_TELEMETRY_DISABLED already turns Paperclip's own telemetry off.
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PORT", "HOST", "NODE_OPTIONS", "PAPERCLIP_CONFIG", "DO_NOT_TRACK"]) {
    delete env[key];
  }
  const attachmentMaxMB = Number(loadSettings().attachmentMaxMB) || DEFAULT_SETTINGS.attachmentMaxMB;
  return {
    ...env,
    ...loadSecrets(),
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    // The release's own agent CLIs (opencode, codex, claude-agent-acp…) come first.
    PATH: [path.join(ROOT, "node_modules", ".bin"), loginShellPath()].join(path.delimiter),
    HOST: "127.0.0.1",
    PORT: String(port),
    SERVE_UI: "true",
    PAPERCLIP_HOME,
    PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    PAPERCLIP_ATTACHMENT_MAX_BYTES: String(Math.floor(attachmentMaxMB * 1024 * 1024)),
    // HTTP agents may only reach private addresses on this allowlist; enrolled
    // Claude Code chats are woken through the local chat bridge.
    PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST: chatBridge.bridgeUrl,
    ...workFolders.serverEnv(),
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
    throw new Error(`Paperclip server not found at ${SERVER_ENTRY}. Run "npm run stage" first.`);
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
    workFolders.ensureFolders();
    serverUrl = await startServer();
    startWorkFolderSync();
    await mainWindow.loadURL(serverUrl);
  } catch (error) {
    setStatus("Paperclip could not start", error.message, tailLog(), true);
  }
}

// Keeps new agents' folders named and their instructions pointing at visible paths.
function startWorkFolderSync() {
  clearInterval(workSyncTimer);
  const sync = async () => {
    if (!serverUrl) return;
    try {
      workFolders.syncInstructions(path.join(PAPERCLIP_HOME, "instances", "default"));
      await workFolders.syncAgentFolders(serverUrl);
    } catch (error) {
      console.error(`Work folder sync failed: ${error.message}`);
    }
  };
  sync();
  workSyncTimer = setInterval(sync, WORK_SYNC_INTERVAL_MS);
}

function openCleanupWindow() {
  if (cleanupWindow) {
    cleanupWindow.focus();
    return;
  }
  cleanupWindow = new BrowserWindow({
    width: 720,
    height: 640,
    title: "Clean Up Old Work",
    webPreferences: { preload: path.join(__dirname, "cleanup-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  cleanupWindow.on("closed", () => {
    cleanupWindow = null;
  });
  cleanupWindow.loadFile(path.join(__dirname, "cleanup.html"));
}

function handleCleanup(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== cleanupWindow?.webContents) throw new Error("Not the cleanup window.");
    return handler(...args);
  });
}

handleCleanup("cleanup:scan", (keepDays) => {
  if (!serverUrl) throw new Error("Paperclip is still starting. Try again in a moment.");
  return workFolders.scan({ baseUrl: serverUrl, keepDays: Number(keepDays) || 0 });
});
handleCleanup("cleanup:trash", async (ids) => {
  const { response } = await dialog.showMessageBox(cleanupWindow, {
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Move ${ids.length} item${ids.length === 1 ? "" : "s"} to the Trash?`,
    detail: "You can restore them from the Trash until you empty it.",
  });
  if (response !== 0) return { cancelled: true, moved: [], failed: [] };
  return workFolders.moveToTrash(ids, (target) => shell.trashItem(target));
});
handleCleanup("cleanup:reveal", (id) => {
  const target = workFolders.itemPath(id);
  if (target) shell.showItemInFolder(target);
});

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Restart Server", click: () => restartServer() },
        { label: "Open in Browser", click: () => serverUrl && shell.openExternal(serverUrl) },
        { label: "Open Work Folder", click: () => shell.openPath(workFolders.workRoot) },
        { label: "Clean Up Old Work…", click: () => openCleanupWindow() },
        { type: "separator" },
        { label: "Show Data Folder", click: () => shell.openPath(DATA_DIR) },
        { label: "Show Server Log", click: () => shell.openPath(SERVER_LOG) },
        { label: "Edit Model Settings…", click: () => (loadSettings(), shell.openPath(SETTINGS_FILE)) },
        { type: "separator" },
        { label: "Enroll Claude Code Chat…", click: () => enrollChatDialog() },
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

// Pick a live Claude Code chat and enroll it as a Paperclip agent.
async function enrollChatDialog() {
  try {
    if (!serverUrl) throw new Error("Paperclip is still starting. Try again in a moment.");
    const enrolled = new Set(Object.values(chatBridge.enrolled()).map((a) => a.sessionId));
    const chats = chatBridge.listLiveChats().filter((c) => !enrolled.has(c.sessionId)).slice(0, 12);
    if (chats.length === 0) {
      await dialog.showMessageBox(mainWindow, {
        message: "No Claude Code chats to enroll",
        detail: "Open the chat in the Claude app or a terminal first. Chats already enrolled are not listed.",
      });
      return;
    }
    const pick = await dialog.showMessageBox(mainWindow, {
      message: "Enroll which Claude Code chat?",
      detail: "Paperclip will create an agent for it and send it work as messages. The chat stays open and usable in Claude.\n\n"
        + chats.map((c) => `${c.name} — ${c.cwd}`).join("\n"),
      buttons: [...chats.map((c) => c.name), "Cancel"],
      cancelId: chats.length,
    });
    if (pick.response >= chats.length) return;
    const chat = chats[pick.response];

    const companies = await fetchJson(`${serverUrl}/api/companies`, {}, 5000);
    if (!Array.isArray(companies) || companies.length === 0) throw new Error("No Paperclip company found.");
    let company = companies[0];
    if (companies.length > 1) {
      const which = await dialog.showMessageBox(mainWindow, {
        message: `Enroll "${chat.name}" in which company?`,
        buttons: [...companies.map((c) => c.name), "Cancel"],
        cancelId: companies.length,
      });
      if (which.response >= companies.length) return;
      company = companies[which.response];
    }

    const result = await chatBridge.enroll(chat, company.id);
    await dialog.showMessageBox(mainWindow, {
      message: result.alreadyEnrolled ? `"${chat.name}" is already enrolled` : `Enrolled "${chat.name}"`,
      detail: "It now appears in Paperclip as an agent. Assign it an issue to send it work.",
    });
    mainWindow?.loadURL(`${serverUrl}/agents/${result.agentId}`);
  } catch (error) {
    dialog.showErrorBox("Enroll Claude Code chat", error.message);
  }
}

async function start() {
  chatBridge.start().catch((error) => {
    fs.appendFile(SERVER_LOG, `[chat-bridge] could not listen: ${error.message}\n`, () => {});
  });
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
