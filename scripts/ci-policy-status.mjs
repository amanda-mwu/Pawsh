const prefixes = {
  "ubuntu-runtime": "Runtime Compatibility — Ubuntu Node ",
  "windows-runtime": "Runtime Compatibility — Windows Node ",
  "macos-runtime": "Runtime Compatibility — macOS Node ",
  "utc-canonicalization": "Runtime Compatibility — UTC Canonicalization"
};

export function isInfrastructureBlocked(group, jobs) {
  const relevant = jobs.filter((job) => job.name?.startsWith(prefixes[group]));
  const unsuccessful = relevant.filter((job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped");
  return unsuccessful.length > 0 && unsuccessful.every((job) => !Array.isArray(job.steps) || job.steps.length === 0);
}
