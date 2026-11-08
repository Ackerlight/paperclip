// Claude Code chat bridge (prototype).
//
// Lets Paperclip drive live Claude Code chats as agents, while the chats stay
// open and usable in the Claude app or a terminal:
//
//   Paperclip heartbeat ──HTTP adapter──▶ this bridge ──inbox socket──▶ live chat
//   live chat ──curl with its agent key──▶ Paperclip API (comments, status…)
//
// Enrolling a chat creates a Paperclip agent of type "http" whose URL points
// here, issues it an agent API key (stored 0600 under the app's data folder),
// and records which Claude session the agent is. On each wake the bridge finds
// the chat's current inbox socket in ~/.claude/sessions/<pid>.json and posts a
// message describing the wake. The message format is the one Claude Code
// prints for scripts: an optional auth line, then
//   {"type":"user","message":{"role":"user","content":"…"}}
// Claude Code treats these as messages from another session, not from the user,
// so a wake can never approve a permission prompt in the chat.

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const MAX_CONTEXT_CHARS = 4000;
const MONITOR_INTERVAL_MS = 10 * 60 * 1000;
const MONITOR_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MONITOR_MAX_ATTEMPTS = 100;

/** "busy", "idle" or "waiting" (e.g. on a permission prompt), from the chat's registry entry. */
function readChatStatus(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), "utf8")).status || "unknown";
  } catch {
    return "unknown";
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

/** Live Claude Code chats on this Mac that accept inbox messages. */
function listLiveChats() {
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const chats = [];
  for (const name of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), "utf8"));
      if (!s.sessionId || !s.messagingSocketPath || !isAlive(s.pid)) continue;
      if (!fs.existsSync(s.messagingSocketPath)) continue;
      chats.push({
        pid: s.pid,
        sessionId: s.sessionId,
        name: s.name || path.basename(s.cwd || "") || s.sessionId.slice(0, 8),
        cwd: s.cwd,
        kind: s.kind,
        entrypoint: s.entrypoint,
        socket: s.messagingSocketPath,
        updatedAt: s.updatedAt || 0,
      });
    } catch {
      // A session file being rewritten; skip it this time.
    }
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

function sendToSocket(socketPath, text) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => {
      conn.end(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    });
    conn.setTimeout(5000, () => conn.destroy(new Error("inbox socket timed out")));
    conn.on("error", reject);
    conn.on("close", (hadError) => !hadError && resolve());
  });
}

async function api(baseUrl, method, route, body, headers = {}) {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.error || JSON.stringify(data) : text;
    throw new Error(`${method} ${route} failed (${res.status}): ${String(detail).slice(0, 300)}`);
  }
  return data;
}

function createChatBridge({ port, dataDir, getServerUrl, skillPath, log = () => {} }) {
  const stateFile = path.join(dataDir, "chat-bridge.json");
  const keysDir = path.join(dataDir, "chat-bridge-keys");
  const bridgeUrl = `http://127.0.0.1:${port}`;

  function loadState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return { agents: {} };
    }
  }
  function saveState(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  const keyPath = (agentId) => path.join(keysDir, `${agentId}.key`);

  function apiGuide(agentId, runId) {
    // The bridge forwards /api to the server, whose own port changes on every
    // restart; chats keep one stable address.
    const base = bridgeUrl;
    const headers = [`-H "Authorization: Bearer $(cat '${keyPath(agentId)}')"`];
    if (runId) headers.push(`-H "X-Paperclip-Run-Id: ${runId}"`);
    return [
      `Paperclip API: ${base}/api (local, this Mac only).`,
      `Authenticate every call with: curl ${headers.join(" ")} …`,
      `Useful calls: GET /api/agents/me, GET /api/agents/me/inbox-lite,`,
      `GET /api/issues/<id>, GET /api/issues/<id>/comments,`,
      `POST /api/issues/<id>/comments {"body": "…markdown…"},`,
      `PATCH /api/issues/<id> {"status": "in_progress" | "in_review" | "done" | "blocked"}.`,
      `Full reference (read when needed): ${skillPath}`,
    ].join("\n");
  }

  function findChat(sessionId) {
    return listLiveChats().find((c) => c.sessionId === sessionId) || null;
  }

  async function enroll(chat, companyId) {
    const state = loadState();
    const existing = Object.entries(state.agents).find(([, a]) => a.sessionId === chat.sessionId);
    if (existing) return { agentId: existing[0], alreadyEnrolled: true };

    const base = getServerUrl();
    if (!base) throw new Error("Paperclip is not running.");
    const agent = await api(base, "POST", `/companies/${companyId}/agents`, {
      name: chat.name,
      role: "general",
      title: "Claude Code chat",
      capabilities: `Live Claude Code chat "${chat.name}" in ${chat.cwd}, driven through the desktop chat bridge.`,
      adapterType: "http",
      adapterConfig: { url: `${bridgeUrl}/wake`, method: "POST", timeoutMs: 15000 },
      metadata: { chatBridge: { sessionId: chat.sessionId, cwd: chat.cwd } },
    });
    const key = await api(base, "POST", `/agents/${agent.id}/keys`, { name: "chat-bridge" });
    const token = key?.token;
    if (!token) throw new Error("Paperclip did not return the new agent key.");
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath(agent.id), `${token}\n`, { mode: 0o600 });

    state.agents[agent.id] = {
      sessionId: chat.sessionId,
      name: chat.name,
      cwd: chat.cwd,
      companyId,
      enrolledAt: new Date().toISOString(),
    };
    saveState(state);
    log(`[chat-bridge] enrolled ${chat.name} (${chat.sessionId}) as agent ${agent.id}`);

    await sendToSocket(chat.socket, [
      `[Paperclip] This chat is now enrolled as the Paperclip agent "${agent.name}" (id ${agent.id}).`,
      `Paperclip will send wake messages here when it assigns you work or mentions you.`,
      `You keep working normally for the user in this chat; for Paperclip work, act through its API and report back there.`,
      "",
      apiGuide(agent.id, null),
      "",
      `Reply here with a one-line acknowledgement. No Paperclip action is needed yet.`,
    ].join("\n"));
    return { agentId: agent.id, alreadyEnrolled: false };
  }

  async function wakeMessage(entry, agentId, body) {
    const ctx = body.context && typeof body.context === "object" ? body.context : {};
    const issueId = ctx.issueId || ctx.taskId || null;
    let issueLine = issueId ? `Issue: ${issueId}` : "No specific issue: check your Paperclip inbox.";
    if (issueId) {
      try {
        const issue = await api(getServerUrl(), "GET", `/issues/${issueId}`);
        issueLine = `Issue: ${issue.identifier} "${issue.title}" (id ${issue.id}, status ${issue.status}).`;
      } catch {
        // Keep the bare ID; the chat can fetch it.
      }
    }
    let contextJson = JSON.stringify(ctx, null, 1);
    if (contextJson.length > MAX_CONTEXT_CHARS) contextJson = `${contextJson.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)`;
    return [
      `[Paperclip] Wake for agent "${entry.name}" (id ${agentId}), run ${body.runId}.`,
      `Reason: ${ctx.wakeReason || ctx.reason || ctx.wakeSource || "heartbeat"}.`,
      issueLine,
      "",
      `Do the work this wake asks for, then report in Paperclip: comment on the issue with what you did,`,
      `and set its status. If you need the user's decision, say so in a comment and set status "blocked".`,
      "",
      apiGuide(agentId, body.runId),
      "",
      "Wake context:",
      "```json",
      contextJson,
      "```",
    ].join("\n");
  }

  // An HTTP agent's run ends as soon as the bridge answers, but the chat works
  // on its own time. So the issue gets a real continuation path: an issue
  // monitor, scheduled as the assignee, that wakes the agent again later. On
  // those wakes the bridge only nudges the chat when it has gone idle with the
  // issue still open, and re-arms the monitor until the chat closes the issue.
  async function armMonitor(agentId, entry, issueId, runId) {
    const base = getServerUrl();
    const headers = {
      authorization: `Bearer ${fs.readFileSync(keyPath(agentId), "utf8").trim()}`,
      "x-paperclip-run-id": runId,
    };
    const issue = await api(base, "GET", `/issues/${issueId}`, null, headers);
    if (!["in_progress", "in_review", "todo"].includes(issue.status)) return issue;
    const now = Date.now();
    const policy = issue.executionPolicy && typeof issue.executionPolicy === "object" ? issue.executionPolicy : {};
    const monitor = {
      nextCheckAt: new Date(now + MONITOR_INTERVAL_MS).toISOString(),
      kind: "external_service",
      serviceName: "Claude Code chat",
      externalRef: entry.sessionId,
      timeoutAt: new Date(now + MONITOR_TIMEOUT_MS).toISOString(),
      maxAttempts: MONITOR_MAX_ATTEMPTS,
      notes: `Live Claude Code chat "${entry.name}" is working on this; the desktop chat bridge checks on it.`,
    };
    return api(base, "PATCH", `/issues/${issueId}`, { executionPolicy: { ...policy, monitor } }, headers);
  }

  async function handleWake(body) {
    const agentId = body.agentId;
    const entry = loadState().agents[agentId];
    if (!entry) return { status: 404, error: `Agent ${agentId} is not an enrolled chat.` };
    const chat = findChat(entry.sessionId);
    if (!chat) return { status: 503, error: `Chat "${entry.name}" is not running. Open it in Claude to receive work.` };
    const ctx = body.context && typeof body.context === "object" ? body.context : {};
    const issueId = ctx.issueId || ctx.taskId || null;
    const reason = String(ctx.wakeReason || ctx.reason || "");
    // A monitor check while the chat is still busy (or waiting on the user)
    // only re-arms the monitor; it does not interrupt the chat.
    const isCheck = /monitor/.test(reason);
    const chatState = readChatStatus(chat.pid);
    if (!(isCheck && chatState !== "idle")) {
      await sendToSocket(chat.socket, await wakeMessage(entry, agentId, body));
      log(`[chat-bridge] woke ${entry.name} for run ${body.runId} (${reason || "wake"})`);
    } else {
      log(`[chat-bridge] ${entry.name} is ${chatState}; re-arming monitor for run ${body.runId}`);
    }
    if (issueId) {
      try {
        await armMonitor(agentId, entry, issueId, body.runId);
      } catch (error) {
        log(`[chat-bridge] could not schedule a monitor on ${issueId}: ${error.message}`);
      }
    }
    return { status: 202, ok: true };
  }

  // Pass a chat's API call through to the current Paperclip server unchanged
  // (the chat's own agent key does the authenticating).
  function proxyApi(req, res) {
    const base = getServerUrl();
    if (!base) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Paperclip is restarting; retry in a moment." }));
    }
    const target = new URL(req.url, base);
    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Paperclip API unreachable: ${error.message}` }));
    });
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
    if (req.url.startsWith("/api/")) return proxyApi(req, res);
    // Paperclip verifies an HTTP agent by probing its URL with HEAD.
    if ((req.method === "HEAD" || req.method === "GET") && req.url === "/wake") {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== "POST" || req.url !== "/wake") return reply(404, { error: "not found" });
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const result = await handleWake(JSON.parse(raw || "{}"));
        reply(result.status, result);
      } catch (error) {
        log(`[chat-bridge] wake failed: ${error.message}`);
        reply(500, { error: error.message });
      }
    });
  });

  return {
    bridgeUrl,
    listLiveChats,
    enroll,
    enrolled: () => loadState().agents,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createChatBridge, listLiveChats };
