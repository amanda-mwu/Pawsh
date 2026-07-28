import process from "node:process";

const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const npmUserAgent = process.env.npm_config_user_agent ?? "";
const npmMajor = Number(/npm\/(\d+)/.exec(npmUserAgent)?.[1]);

if (nodeMajor !== 24 || npmMajor !== 11) {
  throw new Error(
    `Pawsh requires Node 24 and npm 11; received Node ${process.versions.node} and ${npmUserAgent || "unknown npm"}`
  );
}
