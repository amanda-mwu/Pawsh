import React from "react";
import { fireEvent, waitFor, type RenderResult } from "@testing-library/react-native";
import LoginScreen from "../../app/login";
import { ApiError } from "../../src/api/errors";
import { renderScreen } from "../support/harness";

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() })
}));

/**
 * The icon set consumes `name` and renders the mapped font glyph, so the reveal control is checked
 * by the character actually drawn rather than by the prop that was passed in. The underlying
 * `Text` renders `[glyph, null]`.
 */
const revealGlyph = (view: RenderResult): unknown =>
  (view.getByTestId("password-reveal-icon").props.children as unknown[])[0];

describe("Login", () => {
  it("renders the form", async () => {
    const view = await renderScreen(<LoginScreen />, { me: null });
    expect(view.getByTestId("email")).toBeTruthy();
    expect(view.getByTestId("password")).toBeTruthy();
    expect(view.getByTestId("sign-in")).toBeTruthy();
  });

  it("does not call the API with an empty field", async () => {
    const signIn = jest.fn();
    const view = await renderScreen(<LoginScreen />, { me: null, signIn });

    await fireEvent.press(view.getByTestId("sign-in"));

    await waitFor(() => expect(view.getByTestId("login-error")).toBeTruthy());
    expect(signIn).not.toHaveBeenCalled();
  });

  it("signs in with trimmed credentials", async () => {
    const signIn = jest.fn().mockResolvedValue(undefined);
    const view = await renderScreen(<LoginScreen />, { me: null, signIn });

    await fireEvent.changeText(view.getByTestId("email"), "  maya@salon.test ");
    await fireEvent.changeText(view.getByTestId("password"), "correct horse");
    await fireEvent.press(view.getByTestId("sign-in"));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith({ email: "maya@salon.test", password: "correct horse" })
    );
  });

  it("shows the server's own words when the credentials are refused", async () => {
    const signIn = jest.fn().mockRejectedValue(
      new ApiError({ kind: "rejected", status: 401, message: "Invalid email or password" })
    );
    const view = await renderScreen(<LoginScreen />, { me: null, signIn });

    await fireEvent.changeText(view.getByTestId("email"), "maya@salon.test");
    await fireEvent.changeText(view.getByTestId("password"), "wrong");
    await fireEvent.press(view.getByTestId("sign-in"));

    await waitFor(() => expect(view.getByText("Invalid email or password")).toBeTruthy());
  });

  it("masks the password until the groomer asks to see it, and keeps what was typed", async () => {
    const view = await renderScreen(<LoginScreen />, { me: null });

    await fireEvent.changeText(view.getByTestId("password"), "pawsh-local-only");
    expect(view.getByTestId("password").props.secureTextEntry).toBe(true);
    expect(view.getByTestId("password-reveal").props.accessibilityLabel).toBe("Show password");
    expect(view.getByTestId("password-reveal").props.accessibilityState).toMatchObject({
      selected: false
    });

    await fireEvent.press(view.getByTestId("password-reveal"));

    expect(view.getByTestId("password").props.secureTextEntry).toBe(false);
    expect(view.getByTestId("password").props.value).toBe("pawsh-local-only");
    expect(view.getByTestId("password-reveal").props.accessibilityLabel).toBe("Hide password");
    expect(view.getByTestId("password-reveal").props.accessibilityState).toMatchObject({
      selected: true
    });

    await fireEvent.press(view.getByTestId("password-reveal"));

    expect(view.getByTestId("password").props.secureTextEntry).toBe(true);
    expect(view.getByTestId("password").props.value).toBe("pawsh-local-only");
    expect(view.getByTestId("password-reveal").props.accessibilityLabel).toBe("Show password");
    expect(view.getByTestId("password-reveal").props.accessibilityState).toMatchObject({
      selected: false
    });
  });

  it("swaps the eye glyph with the state, and announces only the button's own label", async () => {
    const view = await renderScreen(<LoginScreen />, { me: null });

    const hiddenGlyph = revealGlyph(view);
    expect(hiddenGlyph).toHaveLength(1);

    await fireEvent.press(view.getByTestId("password-reveal"));

    const revealedGlyph = revealGlyph(view);
    expect(revealedGlyph).toHaveLength(1);
    expect(revealedGlyph).not.toBe(hiddenGlyph);

    // The glyph carries no label of its own; the pressable owns it.
    expect(view.getByTestId("password-reveal-icon").props.accessibilityLabel).toBeUndefined();
    expect(view.queryByLabelText("Hide password")).toBeTruthy();
    expect(view.queryByText("Show")).toBeNull();
    expect(view.queryByText("Hide")).toBeNull();
  });

  it("sends the revealed password unchanged", async () => {
    const signIn = jest.fn().mockResolvedValue(undefined);
    const view = await renderScreen(<LoginScreen />, { me: null, signIn });

    await fireEvent.changeText(view.getByTestId("email"), "maya@salon.test");
    await fireEvent.changeText(view.getByTestId("password"), "pawsh-local-only");
    await fireEvent.press(view.getByTestId("password-reveal"));
    await fireEvent.press(view.getByTestId("sign-in"));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith({
        email: "maya@salon.test",
        password: "pawsh-local-only"
      })
    );
  });

  it("reports a lost connection as a connection problem, not a credential problem", async () => {
    const signIn = jest
      .fn()
      .mockRejectedValue(new ApiError({ kind: "offline", status: 0, message: "boom" }));
    const view = await renderScreen(<LoginScreen />, { me: null, signIn });

    await fireEvent.changeText(view.getByTestId("email"), "maya@salon.test");
    await fireEvent.changeText(view.getByTestId("password"), "correct horse");
    await fireEvent.press(view.getByTestId("sign-in"));

    await waitFor(() => expect(view.getByText("No connection.")).toBeTruthy());
  });
});
