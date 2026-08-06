import { spawn } from "node:child_process";
import process from "node:process";
import { spawnDevelopmentChild, waitForChildExit } from "./dev-browser-orchestrator.mjs";

const child = await spawnDevelopmentChild({
  spawnImplementation: spawn,
  script: "check:runtime"
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (value) => { stdout = `${stdout}${value}`.slice(-8_192); });
child.stderr.on("data", (value) => { stderr = `${stderr}${value}`.slice(-8_192); });
const exitCode = await waitForChildExit(child);
if (exitCode !== 0) {
  throw new Error(`Cross-platform npm child failed with exit ${exitCode}\n${stdout}\n${stderr}`);
}
process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, exitCode }) + "\n");
