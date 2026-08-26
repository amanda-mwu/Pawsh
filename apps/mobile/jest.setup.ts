/**
 * Test environment.
 *
 * Every native module the app touches is mocked here rather than in each suite, so a test that
 * forgets one fails loudly on import instead of silently exercising a different code path.
 */
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly"
}));

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Warning: "warning", Success: "success", Error: "error" }
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true)
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => () => undefined),
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true }))
  }
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// `expo-constants` supplies the API base URL. A test must never reach a real host, and the value
// is asserted in the API client suite.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: "https://api.test.pawsh" } } }
}));
