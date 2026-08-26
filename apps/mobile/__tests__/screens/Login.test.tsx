import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import LoginScreen from "../../app/login";
import { ApiError } from "../../src/api/errors";
import { renderScreen } from "../support/harness";

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() })
}));

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
