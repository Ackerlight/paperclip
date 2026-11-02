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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(desktopDir, "stage", "paperclip");
const { paperclipRelease } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
if (!paperclipRelease) throw new Error('Set "paperclipRelease" in desktop/package.json.');

rmSync(path.join(desktopDir, "stage"), { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
writeFileSync(
  path.join(stageDir, "package.json"),
  `${JSON.stringify({ name: "paperclip-desktop-runtime", private: true }, null, 2)}\n`,
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
console.log(`[stage] done: ${stageDir}`);
