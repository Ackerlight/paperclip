// Stages the runtime that ships inside Paperclip.app (Resources/paperclip):
//
//   stage/paperclip/server/dist-runtime   bundled server (workspace packages inlined)
//   stage/paperclip/server/dist           server build assets the bundle reads at runtime
//   stage/paperclip/server/node_modules   production third-party dependencies
//   stage/paperclip/ui/dist               built board UI, served by the server
//
// Usage: node scripts/stage.mjs [--skip-build]

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(desktopDir, "..");
const stageDir = path.join(desktopDir, "stage", "paperclip");
const skipBuild = process.argv.includes("--skip-build");

function run(cmd, args, cwd = repoDir) {
  console.log(`[stage] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PAPERCLIP_TELEMETRY_DISABLED: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
}

if (!skipBuild) {
  run("pnpm", ["build"]);
  run("pnpm", ["--filter", "@paperclipai/server", "build:runtime"]);
}

for (const required of ["server/dist-runtime/index.mjs", "server/dist/index.js", "ui/dist/index.html"]) {
  if (!existsSync(path.join(repoDir, required))) {
    throw new Error(`Missing ${required}; run without --skip-build.`);
  }
}

rmSync(path.join(desktopDir, "stage"), { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// pnpm's default layout keeps every symlink relative and inside the stage dir.
// (A hoisted layout fails here: upstream patches packages the server doesn't ship.)
run("pnpm", ["--filter", "@paperclipai/server", "deploy", "--prod", path.join(stageDir, "server")]);

// pnpm deploy links the server package back to the repo checkout
// (.pnpm/node_modules/@paperclipai/server -> ../../server). Such links break
// inside the app bundle and stop code signing, so drop any that leave the stage.
function removeEscapingLinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target = null;
      try {
        target = realpathSync(full);
      } catch {
        // Dangling: remove below.
      }
      if (!target || !target.startsWith(stageDir + path.sep)) {
        console.log(`[stage] removing link outside the app: ${path.relative(stageDir, full)}`);
        rmSync(full);
      }
    } else if (entry.isDirectory() && !lstatSync(full).isSymbolicLink()) {
      removeEscapingLinks(full);
    }
  }
}
removeEscapingLinks(stageDir);

cpSync(path.join(repoDir, "server", "dist-runtime"), path.join(stageDir, "server", "dist-runtime"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
cpSync(path.join(repoDir, "server", "dist"), path.join(stageDir, "server", "dist"), { recursive: true });
cpSync(path.join(repoDir, "ui", "dist"), path.join(stageDir, "ui", "dist"), { recursive: true });

console.log(`[stage] done: ${stageDir}`);
