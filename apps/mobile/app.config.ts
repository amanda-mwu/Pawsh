import type { ExpoConfig } from "expo/config";

/**
 * Runtime configuration for the Pawsh groomer app.
 *
 * `extra` ships inside the JavaScript bundle and is readable by anyone holding the app, so it
 * carries the API base URL and nothing else. No key, secret, or token belongs here.
 *
 * The base URL comes from `EXPO_PUBLIC_PAWSH_API_URL`. The default is the loopback address the
 * server binds during `npm run dev:server`, which only works in a simulator running on the same
 * machine — a physical device must be given the development machine's LAN address instead. See
 * README.md.
 */
const DEV_FALLBACK_API_URL = "http://localhost:3000";

const apiUrl = process.env.EXPO_PUBLIC_PAWSH_API_URL?.trim() || DEV_FALLBACK_API_URL;

/**
 * The existing EAS project this app is registered as, `@relentlessly/pawsh-mobile`.
 *
 * A dynamic config cannot be written to by the EAS CLI, so the link that `eas init` would
 * normally add to `app.json` has to be declared here by hand. This identifier is not a secret —
 * it names a project rather than granting access to one — so it belongs in the config rather
 * than the environment.
 */
const EAS_PROJECT_ID = "970ba49b-f71a-4d29-be83-4bf0da377b75";

const config: ExpoConfig = {
  name: "Pawsh",
  slug: "pawsh-mobile",
  // Without an owner the config resolves against whichever account is logged in, which is how a
  // second project gets created by accident. This pins it to the organization.
  owner: "relentlessly",
  scheme: "pawsh",
  version: "0.1.0",
  orientation: "default",
  userInterfaceStyle: "automatic",
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.pawsh.mobile"
  },
  android: {
    package: "com.pawsh.mobile"
  },
  // One source of truth for configuration. `expo install` writes discovered plugins into
  // `app.json`, which a dynamic config replaces rather than merges, so new plugins have to be
  // added here or they are silently not applied.
  plugins: ["expo-router", "expo-secure-store", "expo-status-bar"],
  extra: {
    apiUrl,
    eas: {
      projectId: EAS_PROJECT_ID
    }
  }
};

export default config;
