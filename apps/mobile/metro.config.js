const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

// `apps/mobile` is deliberately not an npm workspace member, so `@pawsh/domain` arrives as a
// `file:` symlink pointing outside this project root. Metro has to be told to watch the real
// directory or an edit to the shared domain never invalidates the bundle.
const projectRoot = __dirname;
const domainRoot = path.resolve(projectRoot, "..", "..", "packages", "domain");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [domainRoot];
// Prefer this app's own tree when resolving. Hierarchical lookup stays enabled: the repository
// root holds only the server's dependencies and no copy of React, so there is nothing up there to
// shadow, and disabling it diverges from the resolver configuration Expo expects.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
