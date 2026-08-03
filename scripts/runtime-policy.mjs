const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

export function validateRuntimePolicy(nodeVersion, npmVersion) {
  const node = parseVersion(nodeVersion);
  const npm = parseVersion(npmVersion);
  if (!node || node.prerelease || ![22, 24].includes(node.major)) {
    return { valid: false, reason: `Pawsh supports stable Node 22 or 24; received ${nodeVersion}` };
  }
  if (!npm || npm.prerelease || npm.major !== 11) {
    return { valid: false, reason: `Pawsh supports stable npm 11; received ${npmVersion}` };
  }
  return { valid: true, reason: null };
}
