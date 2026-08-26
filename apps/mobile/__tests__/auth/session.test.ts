import * as SecureStore from "expo-secure-store";
import {
  hasPermission,
  initialSessionState,
  needsLocationChoice,
  sessionReducer
} from "../../src/auth/session";
import { tokenStore } from "../../src/auth/token-store";
import { makeMe } from "../support/fixtures";

describe("sessionReducer", () => {
  it("starts loading so the router never flashes a signed-out screen", () => {
    expect(initialSessionState.status).toBe("loading");
  });

  it("restores to signed-in when a token was on the device", () => {
    const next = sessionReducer(initialSessionState, { type: "restored", token: "abc" });
    expect(next).toMatchObject({ status: "signed-in", token: "abc" });
  });

  it("restores to signed-out and holds no identity when there was no token", () => {
    const withIdentity = sessionReducer(initialSessionState, {
      type: "identified",
      me: makeMe()
    });
    const next = sessionReducer(withIdentity, { type: "restored", token: null });
    expect(next).toEqual({ status: "signed-out", token: null, me: null });
  });

  it("keeps the previous identity across a sign-in so the account does not blank for a frame", () => {
    const me = makeMe();
    const identified = sessionReducer(initialSessionState, { type: "identified", me });
    const signedIn = sessionReducer(identified, { type: "signed-in", token: "new" });
    expect(signedIn.me).toBe(me);
    expect(signedIn.token).toBe("new");
  });

  it("drops everything on sign-out", () => {
    const signedIn = sessionReducer(initialSessionState, { type: "signed-in", token: "t" });
    expect(sessionReducer(signedIn, { type: "signed-out" })).toEqual({
      status: "signed-out",
      token: null,
      me: null
    });
  });
});

describe("hasPermission", () => {
  it("is false with no session at all", () => {
    expect(hasPermission(null, "operations.check_in")).toBe(false);
  });

  it("grants an owner everything without listing it", () => {
    const owner = makeMe({ isOwner: true, permissions: [] });
    expect(hasPermission(owner, "settings.manage")).toBe(true);
  });

  it("reads the granted list for a non-owner", () => {
    const groomer = makeMe({ isOwner: false, permissions: ["operations.check_in"] });
    expect(hasPermission(groomer, "operations.check_in")).toBe(true);
    expect(hasPermission(groomer, "checkout.perform")).toBe(false);
  });
});

describe("needsLocationChoice", () => {
  it("is false for a single-location business, which has no choice to make", () => {
    expect(needsLocationChoice(makeMe())).toBe(false);
  });

  it("is true once there is more than one active location", () => {
    const me = makeMe();
    expect(needsLocationChoice({ ...me, business: { ...me.business!, locationCount: 3 } })).toBe(
      true
    );
  });
});

describe("tokenStore", () => {
  const secure = SecureStore as jest.Mocked<typeof SecureStore>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads and writes through the device keychain, never plain storage", async () => {
    secure.getItemAsync.mockResolvedValueOnce("stored-token");
    await expect(tokenStore.read()).resolves.toBe("stored-token");

    await tokenStore.write("fresh-token");
    expect(secure.setItemAsync).toHaveBeenCalledWith(
      "pawsh.session.token",
      "fresh-token",
      expect.objectContaining({ keychainAccessible: expect.anything() })
    );
  });

  it("degrades to no session when the keychain throws rather than crashing on launch", async () => {
    secure.getItemAsync.mockRejectedValueOnce(new Error("keychain unavailable"));
    await expect(tokenStore.read()).resolves.toBeNull();
  });

  it("swallows a failed write, because a token that authenticates this launch is still useful", async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error("no passcode set"));
    await expect(tokenStore.write("t")).resolves.toBeUndefined();
  });

  it("swallows a failed clear, because the caller is signing out either way", async () => {
    secure.deleteItemAsync.mockRejectedValueOnce(new Error("gone"));
    await expect(tokenStore.clear()).resolves.toBeUndefined();
  });
});
