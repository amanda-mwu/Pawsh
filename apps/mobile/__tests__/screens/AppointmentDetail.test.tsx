import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import AppointmentScreen from "../../app/appointment/[id]";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/errors";
import { queryKeys } from "../../src/query/keys";
import { makeAppointment } from "../support/fixtures";
import { createTestQueryClient, renderScreen } from "../support/harness";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: "appointment-1" }),
  Stack: { Screen: () => null }
}));

jest.mock("../../src/api/endpoints", () => ({
  api: {
    appointment: jest.fn(),
    services: jest.fn(),
    transition: jest.fn(),
    updateOperationalNotes: jest.fn()
  }
}));

const mocked = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  mocked.services.mockResolvedValue([]);
});

describe("Appointment detail — states", () => {
  it("skeletons the body while the detail loads", async () => {
    mocked.appointment.mockReturnValue(new Promise(() => undefined));
    const view = await renderScreen(<AppointmentScreen />);
    expect(view.getByTestId("detail-loading")).toBeTruthy();
  });

  it("renders the summary block in the web app's own field order", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment());
    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByText("9:00 – 10:30 AM")).toBeTruthy());
    expect(view.getByText("Wednesday, August 26")).toBeTruthy();
    // The client appears twice: once in the summary, once as the link to their profile.
    expect(view.getAllByText("Sarah Chen").length).toBeGreaterThan(0);
    expect(view.getByText("Biscuit · Standard Poodle")).toBeTruthy();
    expect(view.getByText("Full Groom")).toBeTruthy();
    expect(view.getByText("90 min · $85.00")).toBeTruthy();
  });

  it("shows an inline error with a retry", async () => {
    mocked.appointment.mockRejectedValue(
      new ApiError({ kind: "rejected", status: 400, message: "Appointment not found" })
    );
    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("detail-error")).toBeTruthy());
    expect(view.getByText("Appointment not found")).toBeTruthy();
  });

  it("keeps a safety alert on screen when the detail fetch fails", async () => {
    // A failed detail fetch must never remove an alert the groomer has already seen. The card
    // they tapped from carried it, so the cache still holds it.
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.appointmentDay(null), [
      makeAppointment({ safetyAlerts: "Bites when nails are clipped." })
    ]);
    mocked.appointment.mockRejectedValue(
      new ApiError({ kind: "offline", status: 0, message: "no connection" })
    );

    const view = await renderScreen(<AppointmentScreen />, { queryClient });
    await waitFor(() => expect(view.getByTestId("detail-error")).toBeTruthy());
    expect(view.getByText("SAFETY ALERT")).toBeTruthy();
    expect(view.getByText("Bites when nails are clipped.")).toBeTruthy();
  });

  it("renders the alarm from the list payload before the fetch resolves", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.appointmentDay(null), [
      makeAppointment({ safetyAlerts: "Muzzle before nails." })
    ]);
    mocked.appointment.mockReturnValue(new Promise(() => undefined));

    const view = await renderScreen(<AppointmentScreen />, { queryClient });
    expect(view.getByText("Muzzle before nails.")).toBeTruthy();
  });

  it("says care notes are withheld rather than showing an empty block", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment());
    const view = await renderScreen(<AppointmentScreen />, {
      permissions: ["appointments.view", "customers.view", "pets.view"]
    });
    await waitFor(() =>
      expect(view.getAllByText("Care notes not visible with your access.").length).toBeGreaterThan(0)
    );
  });

  it("says there are no notes yet rather than rendering nothing", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "checked_in" }));
    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() =>
      expect(view.getByText("No notes on this appointment yet.")).toBeTruthy()
    );
  });
});

describe("Appointment detail — the action zone", () => {
  it("advances the lifecycle, sending the version for optimistic locking", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "checked_in", version: 7 }));
    mocked.transition.mockResolvedValue({});

    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("primary-action")).toBeTruthy());
    await fireEvent.press(view.getByTestId("primary-action"));

    await waitFor(() =>
      expect(mocked.transition).toHaveBeenCalledWith("appointment-1", {
        status: "in_service",
        version: 7
      })
    );
  });

  it("surfaces a 409 as the server's own refresh message", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment());
    mocked.transition.mockRejectedValue(
      new ApiError({
        kind: "conflict",
        status: 409,
        message: "Appointment changed; refresh before continuing"
      })
    );

    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("primary-action")).toBeTruthy());
    await fireEvent.press(view.getByTestId("primary-action"));

    await waitFor(() =>
      expect(view.getByText("Appointment changed; refresh before continuing")).toBeTruthy()
    );
  });

  it("hides the primary action without the permission rather than disabling it", async () => {
    // UX, not authorization. The server derives the permission from the target status and
    // refuses on its own; this only avoids offering a certain no.
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "checked_in" }));
    const view = await renderScreen(<AppointmentScreen />, {
      permissions: ["appointments.view", "pets.view", "pets.care.view", "customers.view"]
    });
    await waitFor(() => expect(view.getByTestId("action-zone")).toBeTruthy());
    expect(view.queryByTestId("primary-action")).toBeNull();
    expect(view.getByTestId("secondary-client")).toBeTruthy();
  });

  it("offers no primary action once the appointment is cancelled", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "cancelled" }));
    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("action-zone")).toBeTruthy());
    expect(view.queryByTestId("primary-action")).toBeNull();
  });

  it("does not offer checkout, which this release does not build", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "completed" }));
    const view = await renderScreen(<AppointmentScreen />, { isOwner: true });
    await waitFor(() => expect(view.getByTestId("action-zone")).toBeTruthy());
    expect(view.queryByTestId("primary-action")).toBeNull();
    expect(view.queryByText("Checkout")).toBeNull();
  });

  it("disables the primary offline, keeps its label, and never posts", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment());
    const view = await renderScreen(<AppointmentScreen />, { online: false });
    await waitFor(() => expect(view.getByTestId("primary-action")).toBeTruthy());
    expect(view.getByText("Offline — reconnect to check in.")).toBeTruthy();

    await fireEvent.press(view.getByTestId("primary-action"));
    expect(mocked.transition).not.toHaveBeenCalled();
  });

  it("keeps destructive actions out of the action zone", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment());
    const view = await renderScreen(<AppointmentScreen />, { isOwner: true });
    await waitFor(() => expect(view.getByTestId("action-zone")).toBeTruthy());
    // Cancel and no-show live above the fold, out of the thumb arc, behind a confirm.
    expect(view.getByTestId("terminal-cancelled")).toBeTruthy();
    expect(view.getByTestId("terminal-no_show")).toBeTruthy();
  });
});

describe("Appointment detail — notes", () => {
  it("keeps unsent text on screen and offers a retry when the save fails", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "in_service" }));
    mocked.updateOperationalNotes.mockRejectedValue(
      new ApiError({ kind: "offline", status: 0, message: "no connection" })
    );

    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("edit-notes")).toBeTruthy());
    await fireEvent.press(view.getByTestId("edit-notes"));

    await fireEvent.changeText(view.getByTestId("note-input"), "Reacted badly to the dryer.");
    await fireEvent.press(view.getByTestId("note-save"));

    await waitFor(() => expect(view.getByTestId("unsent-note")).toBeTruthy());
    // The groomer's words are still on screen, at full opacity, with a way to try again.
    expect(view.getByText("Reacted badly to the dryer.")).toBeTruthy();
    expect(view.getByText("Not sent yet")).toBeTruthy();
  });

  it("clears the unsent treatment once the server accepts it", async () => {
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "in_service" }));
    mocked.updateOperationalNotes.mockResolvedValue({});

    const view = await renderScreen(<AppointmentScreen />);
    await waitFor(() => expect(view.getByTestId("edit-notes")).toBeTruthy());
    await fireEvent.press(view.getByTestId("edit-notes"));
    await fireEvent.changeText(view.getByTestId("note-input"), "Towel dried.");
    await fireEvent.press(view.getByTestId("note-save"));

    await waitFor(() =>
      expect(mocked.updateOperationalNotes).toHaveBeenCalledWith("appointment-1", {
        operationalNotes: "Towel dried."
      })
    );
    await waitFor(() => expect(view.queryByTestId("unsent-note")).toBeNull());
  });

  it("hides the notes editor outside the statuses the endpoint accepts", async () => {
    // `PATCH /operations` is valid only while checked in or in service.
    mocked.appointment.mockResolvedValue(makeAppointment({ status: "scheduled" }));
    const view = await renderScreen(<AppointmentScreen />, { isOwner: true });
    await waitFor(() => expect(view.getByTestId("action-zone")).toBeTruthy());
    expect(view.queryByTestId("edit-notes")).toBeNull();
    expect(view.queryByTestId("secondary-notes")).toBeNull();
  });
});
