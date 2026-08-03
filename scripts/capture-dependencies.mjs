/* global console, process */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to validate the dependency tree");
await mkdir(resolve("artifacts"), { recursive: true });
for (const [name, args] of [
  ["dependencies-all.txt", ["ls", "--all"]],
  ["dependencies-production.txt", ["ls", "--omit=dev", "--all"]]
]) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8" });
  await writeFile(resolve("artifacts", name), `${result.stdout}${result.stderr}`, "utf8");
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`npm ${args.join(" ")} failed with ${result.status}`);
  }
}
console.log("Dependency trees are valid");
