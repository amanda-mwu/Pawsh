import process from "node:process";
import { validateRuntimePolicy } from "./runtime-policy.mjs";

const npmUserAgent = process.env.npm_config_user_agent ?? "";
const npmVersion = /npm\/([^\s]+)/.exec(npmUserAgent)?.[1] ?? "unknown";
const result = validateRuntimePolicy(process.versions.node, npmVersion);

if (!result.valid) throw new Error(`${result.reason}; npm user agent: ${npmUserAgent || "unknown"}`);
