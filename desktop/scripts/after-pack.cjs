// electron-builder afterPack hook: copies the staged Paperclip release into
// Contents/Resources/paperclip. extraResources can't carry it because
// electron-builder always drops `node_modules` from extra resources. afterPack
// runs before code signing, so the copied binaries are signed with the app.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const stageDir = path.join(__dirname, "..", "stage", "paperclip");
  if (!fs.existsSync(path.join(stageDir, "node_modules", "@paperclipai", "server", "dist", "index.js"))) {
    throw new Error('Paperclip release is not staged; run "npm run stage" first.');
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const target = path.join(context.appOutDir, appName, "Contents", "Resources", "paperclip");
  fs.rmSync(target, { recursive: true, force: true });
  // ditto keeps symlinks (node_modules/.bin) and file modes.
  execFileSync("ditto", [stageDir, target], { stdio: "inherit" });
  console.log(`  • staged Paperclip release copied  to=${path.relative(process.cwd(), target)}`);
};
