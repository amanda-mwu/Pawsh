import { spawn } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import { browserLaunchCommand } from "../src/default-browser.js";
import { waitForHealth } from "./health-readiness.mjs";

const appOrigin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const healthUrl = `${new URL(appOrigin).origin}/health`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const server = spawn(npmCommand, ["run", "dev"], { env: process.env, stdio: "inherit", windowsHide: true });

let stopping = false;
function stop(signal) {
  if (stopping || server.exitCode !== null) return;
  stopping = true;
  server.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await waitForHealth(healthUrl, server);
  openDefaultBrowser(new URL(appOrigin).origin);
  process.exitCode = await new Promise((resolve) => server.once("exit", (code) => resolve(code ?? 1)));
} catch (error) {
  stop("SIGTERM");
  throw error;
}

function openDefaultBrowser(url) {
  const launch = browserLaunchCommand(url);
  const browser = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
  browser.once("error", () => {
    process.stderr.write("[ERROR] Default browser could not be opened; use APP_ORIGIN manually.\n");
  });
  browser.unref();
}
