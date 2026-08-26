import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "pawsh.session.token";

/**
 * The session token lives in the Keychain on iOS and the Android Keystore-backed store, never in
 * AsyncStorage — which is an unencrypted file any process with the app's sandbox can read, and is
 * included in device backups.
 *
 * Every call is guarded: SecureStore throws on a device with no passcode configured, on a
 * corrupted keychain entry, and in a test environment with no native module. A throw here must
 * degrade to "no session", never crash the app on launch.
 */
export const tokenStore = {
  async read(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      return null;
    }
  },

  async write(token: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
      });
    } catch {
      // A token that cannot be persisted still authenticates this launch. Losing it on relaunch
      // costs a sign-in; failing the sign-in outright costs the whole session.
    }
  },

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      // Nothing to recover from: the caller is signing out either way.
    }
  }
};
