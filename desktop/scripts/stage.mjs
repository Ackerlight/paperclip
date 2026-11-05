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
writeFileSync(uiBundlePath, ui);
console.log(`[stage] patched multi-file pickers in ${uiBundle}`);
console.log(`[stage] done: ${stageDir}`);
