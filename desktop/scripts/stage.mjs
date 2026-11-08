// Stages the runtime that ships inside Paperclip.app (Resources/paperclip):
// the official `paperclipai` npm release (CLI + @paperclipai/server with its
// built UI and vendored agent runner) and its production dependencies.
//
// The published packages are built to run from any location. The fork's own
// server bundle (server/dist-runtime) is not: esbuild bakes the build
// machine's absolute paths into it, so it only works next to the checkout.
//
// Usage: node scripts/stage.mjs   (version: "paperclipRelease" in package.json)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(desktopDir, "stage", "paperclip");
const { paperclipRelease } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
if (!paperclipRelease) throw new Error('Set "paperclipRelease" in desktop/package.json.');

rmSync(path.join(desktopDir, "stage"), { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
// The upstream workspace forces these agent runtimes with pnpm overrides
// (pnpm-workspace.yaml), and the runner's ACPX integrity table pins the
// resolved versions. Published packages don't carry the overrides, so npm would
// install claude-agent-acp's declared SDK 0.3.257, whose Claude Code is too old
// for current Claude models. Keep these in step with upstream's overrides.
const overrides = {
  "@agentclientprotocol/claude-agent-acp@0.73.0": { "@anthropic-ai/claude-agent-sdk": "0.3.286" },
  "@agentclientprotocol/codex-acp@1.6.2": { "@openai/codex": "0.160.0" },
};
writeFileSync(
  path.join(stageDir, "package.json"),
  `${JSON.stringify({ name: "paperclip-desktop-runtime", private: true, overrides }, null, 2)}\n`,
);

console.log(`[stage] npm install paperclipai@${paperclipRelease}`);
execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", `paperclipai@${paperclipRelease}`],
  { cwd: stageDir, stdio: "inherit", env: { ...process.env, PAPERCLIP_TELEMETRY_DISABLED: "1" } },
);

const serverEntry = path.join(stageDir, "node_modules", "@paperclipai", "server", "dist", "index.js");
const uiIndex = path.join(stageDir, "node_modules", "@paperclipai", "server", "ui-dist", "index.html");
for (const required of [serverEntry, uiIndex]) {
  if (!existsSync(required)) throw new Error(`Release is missing ${path.relative(stageDir, required)}`);
}

// The release's chat composers only let the file picker choose one file at a
// time, although their drop handlers already take several. Patch the built UI:
// - task chat: `multiple` was set only while creating a task; its change
//   handler already uploads every picked file in both cases.
// - issue chat: allow `multiple` and route picked files through the composer's
//   own multi-file drop handler (handleDroppedFiles).
// Each patch must match exactly once, so a new release fails loudly here.
const assetsDir = path.join(path.dirname(uiIndex), "assets");
const uiBundle = readdirSync(assetsDir).find((name) => /^index-.*\.js$/.test(name)
  && readFileSync(path.join(assetsDir, name), "utf8").includes('"handleAttachFile"'));
if (!uiBundle) throw new Error("UI bundle with handleAttachFile not found");
const uiBundlePath = path.join(assetsDir, uiBundle);
let ui = readFileSync(uiBundlePath, "utf8");
function patchOnce(label, pattern, replace) {
  const matches = ui.match(new RegExp(pattern.source, "g")) ?? [];
  if (matches.length !== 1) throw new Error(`UI patch "${label}": expected 1 match, found ${matches.length}`);
  ui = ui.replace(pattern, replace);
}
patchOnce(
  "task chat picker",
  /multiple:!![\w$]+,onChange:([\w$]+)/,
  "multiple:!0,onChange:$1",
);
// async function wt(e){const f=e.target.files?.[0];if(f){…}}r(wt,"handleAttachFile");
// async function $t(list){…}r($t,"handleDroppedFiles")
const attach = ui.match(/async function ([\w$]+)\(([\w$]+)\)\{const [\w$]+=\2\.target\.files\?\.\[0\];if\([\w$]+\)\{[\w$]+\(!0\);try\{await [\w$]+\([\w$]+\)\}finally\{[\w$]+\(!1\),([\w$]+)\.current&&\(\3\.current\.value=""\)\}\}\}[\w$]+\(\1,"handleAttachFile"\);async function ([\w$]+)\(/);
if (!attach) throw new Error('UI patch "issue chat picker": handleAttachFile shape not found');
const [, attachFn, evt, inputRef, droppedFn] = attach;
const esc = (s) => s.replace(/[$]/g, "\\$");
patchOnce(
  "issue chat handler",
  new RegExp(`async function ${esc(attachFn)}\\(${esc(evt)}\\)\\{const [\\w$]+=${esc(evt)}\\.target\\.files\\?\\.\\[0\\];if\\([\\w$]+\\)\\{[^}]*\\}finally\\{[^}]*\\}\\}\\}`),
  // `$` in a replacement string is special; use a function so names like $t survive.
  () => `async function ${attachFn}(${evt}){try{await ${droppedFn}(${evt}.target.files)}finally{${inputRef}.current&&(${inputRef}.current.value="")}}`,
);
patchOnce(
  "issue chat picker",
  new RegExp(`ref:${esc(inputRef)},type:"file",className:"hidden",onChange:${esc(attachFn)}\\}`),
  () => `ref:${inputRef},type:"file",className:"hidden",multiple:!0,onChange:${attachFn}}`,
);
console.log(`[stage] patched multi-file pickers in ${uiBundle}`);

// Budget hard stops, part 1 of 2: the UI. The release can only set a hard stop
// through the API, and its incident card calls every incident a hard stop.
// - budget card: a hard stop switch, on every page that shows the card. It posts
//   directly and reloads, because the agent and project pages have no mutation
//   that can carry the setting.
// - incident card: warnings say they are warnings and nothing was paused.
function replaceOnce(text, label, find, replace) {
  const count = text.split(find).length - 1;
  if (count !== 1) throw new Error(`Patch "${label}": expected 1 match, found ${count}`);
  return text.replace(find, () => replace);
}
function patchUi(label, find, replace) {
  ui = replaceOnce(ui, label, find, replace);
}
const hardStopToggle = `function PaperclipDesktopHardStopToggle({summary:e}){
const[busy,setBusy]=(0,m.useState)(!1),[error,setError]=(0,m.useState)(null);
if(!(e.amount>0))return null;
const on=e.hardStopEnabled;
async function change(ev){const next=ev.target.checked;setBusy(!0);setError(null);
try{const res=await fetch(\`/api/companies/\${e.companyId}/budgets/policies\`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
body:JSON.stringify({scopeType:e.scopeType,scopeId:e.scopeId,metric:e.metric,windowKind:e.windowKind,amount:e.amount,hardStopEnabled:next})});
if(!res.ok){const body=await res.json().catch(()=>({}));throw new Error(body.error||\`Request failed (\${res.status})\`)}
window.location.reload()}catch(err){setError(err.message);setBusy(!1)}}
return(0,t.jsxs)("div",{className:"space-y-1",children:[
(0,t.jsxs)("label",{className:"flex items-center gap-2 text-sm",children:[(0,t.jsx)("input",{type:"checkbox",checked:on,disabled:busy,onChange:change}),"Hard stop: pause when this budget is reached"]}),
(0,t.jsx)("p",{className:"text-xs text-muted-foreground",children:on?"Work pauses at the limit, or while a billed run's cost is unsettled.":\`Warning only: you get an alert at \${e.warnPercent}% and work keeps running, even past the limit.\`}),
error?(0,t.jsx)("p",{role:"alert",className:"text-xs text-destructive",children:error}):null]})}
`;
const budgetCard = 'function zIe({summary:e,onSave:s,onUnpricedUsagePolicyChange:n,onReservationChange:a,isSaving:i,compact:o=!1,variant:l="card"}){';
patchUi("budget card component", budgetCard, hardStopToggle + budgetCard);
const cardChildren = 'I,E,b,y===null?(0,t.jsx)("p",{className:"text-xs text-destructive",children:"Enter a valid non-negative dollar amount."})';
if (ui.split(cardChildren).length - 1 !== 2) throw new Error('Patch "budget card layouts": expected 2 matches');
ui = ui.split(cardChildren).join(`I,(0,t.jsx)(PaperclipDesktopHardStopToggle,{summary:e}),${cardChildren.slice(2)}`);
patchUi("incident title", 'children:[e.scopeType," hard stop"]', 'children:[e.scopeType,e.thresholdType==="soft"?" budget warning":" hard stop"]');
patchUi(
  "incident notice style",
  '"flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-950/90 dark:text-red-50/90"',
  'e.thresholdType==="soft"?"flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200":"flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-950/90 dark:text-red-50/90"',
);
patchUi(
  "incident notice text",
  'children:e.scopeType==="project"?"Project execution is paused. New work in this project will not start until you resolve the budget incident."',
  'children:e.thresholdType==="soft"?"This is only a warning. Nothing has been paused. If this bills through OpenRouter, check your credits and top up there.":e.scopeType==="project"?"Project execution is paused. New work in this project will not start until you resolve the budget incident."',
);
patchUi("incident raise button", 'a?"Applying...":"Raise budget & resume"', 'a?"Applying...":e.thresholdType==="soft"?"Raise budget":"Raise budget & resume"');
patchUi("incident dismiss button", 'disabled:a,onClick:n,children:"Keep paused"', 'disabled:a,onClick:n,children:e.thresholdType==="soft"?"Dismiss":"Keep paused"');
writeFileSync(uiBundlePath, ui);
console.log(`[stage] patched budget UI in ${uiBundle}`);

// Budget hard stops, part 2 of 2: the server.
// - A run on a subscription costs $0 by the accounting's own rule, so its missing
//   receipt must not stop an agent. A run killed mid-flight never gets one, which
//   paused agents at $0 and made raising the budget refuse forever. Metered runs
//   still count: their receipts carry real money.
// - New budgets warn unless someone turns the hard stop on.
// - With the hard stop off, the status says warning and raising never refuses.
const servicesDir = path.join(path.dirname(serverEntry), "services");
function patchServerFile(name, patches) {
  const file = path.join(servicesDir, name);
  let text = readFileSync(file, "utf8");
  for (const [label, find, replace] of patches) text = replaceOnce(text, label, find, replace);
  writeFileSync(file, text);
}
patchServerFile("budgets.js", [
  [
    "subscription runs owe no receipt",
    'eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]), policy.scopeType === "agent"',
    'eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]), sql `${heartbeatRuns.usageJson}->>\'billingType\' is distinct from \'subscription_included\'`, policy.scopeType === "agent"',
  ],
  ["new budgets warn", "hardStopEnabled: input.hardStopEnabled ?? true,", "hardStopEnabled: input.hardStopEnabled ?? false,"],
  [
    "status without a hard stop",
    "? budgetStatusFromObserved(observedAmountExact, amount, policy.warnPercent)",
    '? ((status) => status === "hard_stop" && !policy.hardStopEnabled ? "warning" : status)(budgetStatusFromObserved(observedAmountExact, amount, policy.warnPercent))',
  ],
  [
    "raise refused for unpriced usage",
    'if (policy.unpricedUsagePolicy !== "allow" && observed.unpricedEventCount > 0) {\n                    throw unprocessable("Resolve unpriced usage or explicitly allow it in the budget policy before resuming");',
    'if (policy.hardStopEnabled && policy.unpricedUsagePolicy !== "allow" && observed.unpricedEventCount > 0) {\n                    throw unprocessable("Resolve unpriced usage or explicitly allow it in the budget policy before resuming. To continue now, turn off the hard stop on this budget.");',
  ],
  [
    "raise refused for unsettled runs",
    'if (observed.pendingRunCount > 0)\n                    throw unprocessable("Completed runs must finish accounting before resuming");',
    'if (policy.hardStopEnabled && observed.pendingRunCount > 0)\n                    throw unprocessable("Completed runs must finish accounting before resuming. To continue now, turn off the hard stop on this budget.");',
  ],
]);
patchServerFile("attention.js", [
  // A warning records its spend once, when it opens at the policy's threshold
  // (80% by default). This 85% filter on that frozen figure could hide it forever.
  [
    "warnings reach Decisions",
    'if (incident.thresholdType !== "hard" && observedPercent < 85)',
    'if (false)',
  ],
  [
    "warning text",
    '"Budget crossed the 85% warning threshold."',
    '"Budget crossed its warning threshold. Work keeps running. If this bills through OpenRouter, check your credits and top up there."',
  ],
  [
    "warning dismiss label",
    'label: "Keep paused", description: "Dismiss or keep the budget stop in place."',
    'label: incident.thresholdType === "hard" ? "Keep paused" : "Dismiss", description: "Dismiss or keep the budget stop in place."',
  ],
]);
console.log("[stage] patched budget enforcement");

// Agent folders and Paperclip's own clones live where Finder can browse. The desktop
// shell names the roots; without them the release's own paths still apply.
const homePathsFile = path.join(path.dirname(serverEntry), "home-paths.js");
let homePaths = readFileSync(homePathsFile, "utf8");
homePaths = `import { readdirSync as paperclipDesktopReaddir } from "node:fs";\n${homePaths}`;
homePaths = replaceOnce(
  homePaths,
  "visible agent folder",
  'return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);',
  `const visibleAgentRoot = process.env.PAPERCLIP_DESKTOP_AGENT_ROOT?.trim();
    if (visibleAgentRoot) {
        const suffix = \` (\${trimmed.slice(0, 8)})\`;
        let names = [];
        try {
            names = paperclipDesktopReaddir(visibleAgentRoot);
        }
        catch {
            // The folder is created on first use.
        }
        return path.resolve(visibleAgentRoot, names.find((name) => name.endsWith(suffix)) ?? trimmed);
    }
    return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);`,
);
homePaths = replaceOnce(
  homePaths,
  "visible managed projects",
  'return path.resolve(resolvePaperclipInstanceRoot(), "projects", sanitizeFriendlyPathSegment(companyId, "company")',
  'return path.resolve(process.env.PAPERCLIP_DESKTOP_MANAGED_PROJECTS_ROOT?.trim() || path.resolve(resolvePaperclipInstanceRoot(), "projects"), sanitizeFriendlyPathSegment(companyId, "company")',
);
writeFileSync(homePathsFile, homePaths);
patchServerFile(path.join("heartbeat", "workspaces.js"), [
  [
    "managed source root",
    "managedSourceRoot: resolvePaperclipInstanceRoot(),",
    "managedSourceRoot: process.env.PAPERCLIP_DESKTOP_MANAGED_PROJECTS_ROOT?.trim() || resolvePaperclipInstanceRoot(),",
  ],
]);
console.log("[stage] patched agent and project folders");
console.log(`[stage] done: ${stageDir}`);
