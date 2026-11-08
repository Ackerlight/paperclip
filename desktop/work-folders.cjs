// Folders people can see in Finder, for everything agents make.
//
//   ~/Paperclip/Agents/<Agent Name> (<id8>)/   each agent's working folder
//   ~/Paperclip/Work/<ISSUE-ID>/               files made for a task
//   ~/Developer/Paperclip-Worktrees/           Git worktrees agents create
//   ~/Developer/Paperclip-Projects/            repos Paperclip clones itself
//   ~/Developer/_Superseded/                   older duplicate repos set aside
//
// The database, secrets and logins stay in Application Support on purpose.
// Cleanup only ever moves things to the Trash, and only what its last scan listed.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BLOCK_START = "<!-- paperclip-desktop-paths:start -->";
const BLOCK_END = "<!-- paperclip-desktop-paths:end -->";
const CLOSED_STATUSES = new Set(["done", "cancelled"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function createWorkFolders({ home = os.homedir() } = {}) {
  const workRoot = path.join(home, "Paperclip");
  const agentsRoot = path.join(workRoot, "Agents");
  const tasksRoot = path.join(workRoot, "Work");
  const developerRoot = path.join(home, "Developer");
  const worktreesRoot = path.join(developerRoot, "Paperclip-Worktrees");
  const managedProjectsRoot = path.join(developerRoot, "Paperclip-Projects");
  const supersededRoot = path.join(developerRoot, "_Superseded");
  let lastScan = new Map();

  function ensureFolders() {
    for (const dir of [agentsRoot, tasksRoot, worktreesRoot, managedProjectsRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const readme = path.join(workRoot, "README.txt");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        "Paperclip work folder",
        "",
        "Agents    Each agent's own working folder.",
        "Work      Files made for a task, one folder per issue, such as CRE-203.",
        "",
        "To remove old files, choose Paperclip > Clean Up Old Work in the app.",
        "It moves what you pick to the Trash.",
        "",
      ].join("\n"));
    }
  }

  function serverEnv() {
    return {
      PAPERCLIP_DESKTOP_AGENT_ROOT: agentsRoot,
      PAPERCLIP_DESKTOP_MANAGED_PROJECTS_ROOT: managedProjectsRoot,
    };
  }

  function instructionsBlock() {
    return [
      BLOCK_START,
      "## Where your files go",
      "",
      "The board reviews your files in Finder, so keep them where Finder can browse:",
      "",
      `- Put samples, renders, reports and other task files in \`${tasksRoot}/<ISSUE-ID>/\`, for example \`${tasksRoot}/CRE-203/\`. Create the folder if needed.`,
      `- Put new Git worktrees in \`${worktreesRoot}/<ISSUE-ID>-<repo>/\`.`,
      `- Every Git repo lives under \`${developerRoot}\`. Do not clone or create repos anywhere else.`,
      "- Never put work under `~/Library`, including `~/Library/Application Support/Paperclip`.",
      "- When you report a file, give its full path.",
      "",
      "## Reporting cost",
      "",
      "Do not close comments or replies with a spend, cost or billing note, such as which plan a run used or that nothing paid was called. The board tracks spend on the Dashboard and Costs pages.",
      "",
      "Mention money only when you need approval for a paid action, something charged money unexpectedly, the task itself is about cost, or the board asks.",
      BLOCK_END,
    ].join("\n");
  }

  function applyInstructions(file) {
    const current = fs.readFileSync(file, "utf8");
    const block = instructionsBlock();
    const start = current.indexOf(BLOCK_START);
    const end = current.indexOf(BLOCK_END);
    const next = start >= 0 && end > start
      ? current.slice(0, start) + block + current.slice(end + BLOCK_END.length)
      : `${current.replace(/\s*$/, "")}\n\n${block}\n`;
    if (next === current) return false;
    const temp = `${file}.paperclip-tmp`;
    fs.writeFileSync(temp, next);
    fs.renameSync(temp, file);
    return true;
  }

  function syncInstructions(instanceRoot) {
    const companies = path.join(instanceRoot, "companies");
    let changed = 0;
    for (const company of listDir(companies)) {
      for (const agent of listDir(path.join(companies, company, "agents"))) {
        const file = path.join(companies, company, "agents", agent, "instructions", "AGENTS.md");
        if (fs.existsSync(file) && applyInstructions(file)) changed += 1;
      }
    }
    return changed;
  }

  // Names each agent's folder before its first run. An existing folder is never
  // renamed, because an agent may be working in it.
  async function syncAgentFolders(baseUrl) {
    const existing = listDir(agentsRoot);
    let created = 0;
    for (const company of await getJson(`${baseUrl}/api/companies`)) {
      for (const agent of await getJson(`${baseUrl}/api/companies/${company.id}/agents`)) {
        const suffix = ` (${agent.id.slice(0, 8)})`;
        if (existing.some((name) => name === agent.id || name.endsWith(suffix))) continue;
        const name = `${agentFolderName(agent.name)}${suffix}`;
        fs.mkdirSync(path.join(agentsRoot, name), { recursive: true });
        existing.push(name);
        created += 1;
      }
    }
    return created;
  }

  async function issueStatus(baseUrl, identifier, cache) {
    if (!identifier) return null;
    const key = identifier.toUpperCase();
    if (!cache.has(key)) {
      let issue = null;
      try {
        issue = await getJson(`${baseUrl}/api/issues/${key}`);
      } catch {
        // Listed as not linked to an issue, so it is never ticked for the user.
      }
      cache.set(key, issue ? issue.status : null);
    }
    return cache.get(key);
  }

  async function scan({ baseUrl, keepDays = 14, now = Date.now() }) {
    const cutoff = now - keepDays * DAY_MS;
    const cache = new Map();
    const items = [];

    for (const name of listDir(tasksRoot)) {
      const target = path.join(tasksRoot, name);
      if (!fs.statSync(target).isDirectory()) continue;
      const status = await issueStatus(baseUrl, issueIdIn(name), cache);
      const usage = measure(target);
      const closed = CLOSED_STATUSES.has(status);
      items.push({
        kind: "task",
        path: target,
        label: name,
        detail: status ? `Issue ${status}` : "Not linked to an issue",
        ...usage,
        locked: Boolean(status) && !closed,
        ticked: closed && usage.modified < cutoff,
      });
    }

    for (const name of listDir(worktreesRoot)) {
      const target = path.join(worktreesRoot, name);
      if (!fs.statSync(target).isDirectory()) continue;
      const status = await issueStatus(baseUrl, issueIdIn(name), cache);
      const git = gitState(target);
      const usage = measure(target);
      const closed = CLOSED_STATUSES.has(status);
      items.push({
        kind: "worktree",
        path: target,
        label: name,
        detail: [status ? `Issue ${status}` : "Not linked to an issue", ...git.notes].join(". "),
        commonDir: git.commonDir,
        warning: git.atRisk,
        ...usage,
        locked: Boolean(status) && !closed,
        ticked: closed && !git.atRisk && usage.modified < cutoff,
      });
    }

    for (const agent of listDir(agentsRoot)) {
      const dir = path.join(agentsRoot, agent);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of listDir(dir)) {
        if (name.startsWith(".")) continue;
        const target = path.join(dir, name);
        const usage = measure(target);
        if (usage.modified >= cutoff) continue;
        items.push({ kind: "agent", path: target, label: `${agent} / ${name}`, detail: "Loose file in an agent folder", ...usage, ticked: false });
      }
    }

    for (const name of listDir(supersededRoot)) {
      const target = path.join(supersededRoot, name);
      if (!fs.statSync(target).isDirectory()) continue;
      const git = gitState(target);
      items.push({ kind: "superseded", path: target, label: name, detail: ["Older duplicate repo", ...git.notes].join(". "), warning: git.atRisk, ...measure(target), ticked: false });
    }

    lastScan = new Map(items.map((item, index) => [String(index), { ...item, id: String(index) }]));
    return [...lastScan.values()].map(({ commonDir, ...item }) => item);
  }

  function isCleanable(target) {
    const parent = path.dirname(target);
    return parent === tasksRoot || parent === worktreesRoot || parent === supersededRoot
      || path.dirname(parent) === agentsRoot;
  }

  // Ids come from the window, so only entries from the last scan can be touched.
  async function moveToTrash(ids, trashItem) {
    const moved = [];
    const failed = [];
    for (const id of ids) {
      const item = lastScan.get(String(id));
      if (!item || item.locked || !isCleanable(item.path)) {
        failed.push({ id, reason: "This item is no longer available to clean up. Scan again." });
        continue;
      }
      try {
        await trashItem(item.path);
        if (item.commonDir) pruneWorktrees(item.commonDir);
        lastScan.delete(String(id));
        moved.push({ id, path: item.path, sizeBytes: item.sizeBytes });
      } catch (error) {
        failed.push({ id, path: item.path, reason: error.message });
      }
    }
    return { moved, failed };
  }

  function itemPath(id) {
    return lastScan.get(String(id))?.path ?? null;
  }

  return {
    workRoot, agentsRoot, tasksRoot, worktreesRoot, managedProjectsRoot, supersededRoot,
    ensureFolders, serverEnv, applyInstructions, syncInstructions, syncAgentFolders, scan, moveToTrash, itemPath,
  };
}

function agentFolderName(name) {
  const clean = String(name ?? "").replace(/[/:\\]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return clean || "Agent";
}

function issueIdIn(name) {
  const match = /^([a-z]+-\d+)(?![0-9a-z])/i.exec(name);
  return match ? match[1] : null;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

// Total size and the newest change anywhere inside, so one fresh file keeps a folder.
function measure(target) {
  let sizeBytes = 0;
  let modified = 0;
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    sizeBytes += stat.size;
    modified = Math.max(modified, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const name of listDir(current)) pending.push(path.join(current, name));
    }
  }
  return { sizeBytes, modified };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function gitState(target) {
  let commonDir;
  try {
    commonDir = path.resolve(target, git(target, ["rev-parse", "--git-common-dir"]));
  } catch {
    return { commonDir: null, atRisk: false, notes: ["Its Git link is broken, so it is no longer usable as a checkout"] };
  }
  const notes = [];
  try {
    const dirty = git(target, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    if (dirty) notes.push(`${dirty} uncommitted change${dirty === 1 ? "" : "s"}`);
    const branch = git(target, ["branch", "--show-current"]);
    let unpushed = 0;
    if (branch) {
      unpushed = Number(git(target, ["rev-list", "--count", branch, "--not", "--remotes"]));
      if (unpushed) notes.push(`${unpushed} commit${unpushed === 1 ? "" : "s"} not on GitHub`);
    } else {
      notes.push("Not on a branch");
    }
    return { commonDir, atRisk: dirty > 0 || unpushed > 0, notes };
  } catch {
    // An empty repo or anything else Git can't answer is treated as possibly holding work.
    return { commonDir, atRisk: true, notes: [...notes, "Git could not confirm its state"] };
  }
}

function pruneWorktrees(commonDir) {
  try {
    execFileSync("git", ["--git-dir", commonDir, "worktree", "prune"], { timeout: 30000, stdio: "ignore" });
  } catch {
    // The folder is already in the Trash; a stale entry is harmless and Git prunes it later.
  }
}

module.exports = { createWorkFolders };
