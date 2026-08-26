const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

// `apps/mobile` is deliberately not an npm workspace member, so `@pawsh/domain` arrives as a
// `file:` symlink pointing outside this project root. Metro has to be told to watch the real
// directory or an edit to the shared domain never invalidates the bundle.
const projectRoot = __dirname;
const domainRoot = path.resolve(projectRoot, "..", "..", "packages", "domain");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [domainRoot];
// Resolve every dependency from this app's own tree. The repository root has its own
// `node_modules` for the server, and letting Metro walk up into it is how a bundle ends up
// containing a second copy of React.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
