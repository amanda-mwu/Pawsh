import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import TodayScreen from "../../app/(tabs)/index";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/errors";
import { makeAppointment, makeMe } from "../support/fixtures";
import { renderScreen } from "../support/harness";

// Jest hoists mock factories above the file, so the spy has to be named `mock*` to be reachable.
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() })
}));

jest.mock("../../src/api/endpoints", () => ({
  api: {
    appointments: jest.fn(),
    services: jest.fn(),
    employees: jest.fn(),
    transition: jest.fn()
  }
}));

const mocked = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  mocked.services.mockResolvedValue([]);
  mocked.employees.mockResolvedValue([
    {
      id: "employee-1", displayName: "Maya R.", membershipId: "membership-1",
      colorSlot: null, active: true
    }
  ]);
});

describe("Today — states", () => {
  it("shows skeletons while the day is loading, without a spinner", async () => {
    mocked.appointments.mockReturnValue(new Promise(() => undefined));
    const view = await renderScreen(<TodayScreen />);
    expect(view.getByTestId("today-loading")).toBeTruthy();
  });

  it("shows the web app's own empty copy when the day is genuinely clear", async () => {
    mocked.appointments.mockResolvedValue([]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("today-empty")).toBeTruthy());
    expect(view.getByText("No appointments today.")).toBeTruthy();
  });

  it("distinguishes an empty filter from an empty day", async () => {
    // Never show the generic empty state when a filter caused it: the groomer would read it as
    // "the salon is closed".
    mocked.appointments.mockResolvedValue([
      makeAppointment({ id: "other", employeeId: "employee-2", groomers: [] })
    ]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("today-empty-filtered")).toBeTruthy());

    await fireEvent.press(view.getByText("Show all groomers"));
    // The only remaining appointment becomes the promoted card rather than a plain row.
    await waitFor(() => expect(view.getByTestId("now-card-other")).toBeTruthy());
  });

  it("shows an inline error card with a retry, not a toast", async () => {
    mocked.appointments.mockRejectedValue(
      new ApiError({ kind: "rejected", status: 400, message: "boom" })
    );
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("today-error")).toBeTruthy());
    expect(view.getByText("Today's schedule could not be loaded.")).toBeTruthy();

    mocked.appointments.mockResolvedValue([makeAppointment()]);
    await fireEvent.press(view.getByTestId("retry"));
    await waitFor(() => expect(view.getByTestId("now-card-appointment-1")).toBeTruthy());
  });

  it("renders a populated day with its status, pet and services", async () => {
    mocked.appointments.mockResolvedValue([
      makeAppointment({ id: "a", status: "in_service" }),
      makeAppointment({ id: "b", petName: "Juno", breed: "Aussie" })
    ]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("now-card-a")).toBeTruthy());
    expect(view.getByTestId("appointment-b")).toBeTruthy();
    expect(view.getByText("Juno")).toBeTruthy();
    expect(view.getByText("IN SERVICE")).toBeTruthy();
    expect(view.getAllByText("9:00 – 10:30 AM")).toHaveLength(2);
  });

  it("promotes the appointment on the table and gives it the primary action inline", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment({ status: "in_service" })]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("now-primary")).toBeTruthy());
    expect(view.getByLabelText("Complete")).toBeTruthy();
  });

  it("folds finished work into a footer instead of deleting it", async () => {
    mocked.appointments.mockResolvedValue([
      makeAppointment({ id: "done", status: "completed" }),
      makeAppointment({ id: "next" })
    ]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("finished-toggle")).toBeTruthy());
    expect(view.queryByTestId("appointment-done")).toBeNull();

    await fireEvent.press(view.getByTestId("finished-toggle"));
    await waitFor(() => expect(view.getByTestId("appointment-done")).toBeTruthy());
  });
});

describe("Today — safety", () => {
  it("renders the alarm on a card carrying a safety alert", async () => {
    mocked.appointments.mockResolvedValue([
      makeAppointment({ safetyAlerts: "Bites when nails are clipped. Muzzle first." })
    ]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByText("SAFETY ALERT")).toBeTruthy());
    expect(view.getByText("Bites when nails are clipped. Muzzle first.")).toBeTruthy();
  });

  it("states the absence of an alert rather than rendering nothing", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment()]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByText("✓ No safety alerts on file.")).toBeTruthy());
  });

  it("says care notes are withheld rather than looking like no alerts", async () => {
    // Care fields are redacted to null, not omitted, so a withheld record and a clean record are
    // byte-identical. Blank space would read as "this dog is fine".
    mocked.appointments.mockResolvedValue([makeAppointment()]);
    const view = await renderScreen(<TodayScreen />, {
      permissions: ["appointments.view", "calendar.view"]
    });
    await waitFor(() =>
      expect(view.getByText("Care notes not visible with your access.")).toBeTruthy()
    );
  });

  it("flags rabies that needs attention", async () => {
    mocked.appointments.mockResolvedValue([
      makeAppointment({ rabiesAppointmentStatus: "expired" })
    ]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByText("Rabies needed")).toBeTruthy());
  });
});

describe("Today — permissions", () => {
  it("hides the primary action when the permission is missing", async () => {
    // UX, not authorization: the server derives the same permission from the target status and
    // refuses independently. Hiding the button only keeps a groomer from tapping a certain no.
    mocked.appointments.mockResolvedValue([makeAppointment({ status: "in_service" })]);
    const view = await renderScreen(<TodayScreen />, {
      permissions: ["appointments.view", "calendar.view", "pets.care.view"]
    });
    await waitFor(() => expect(view.getByTestId("now-card-appointment-1")).toBeTruthy());
    expect(view.queryByTestId("now-primary")).toBeNull();
  });

  it("shows the action to a groomer who holds the permission", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment({ status: "in_service" })]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("now-primary")).toBeTruthy());
  });

  it("shows everything to an owner without listing permissions", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment({ status: "checked_in" })]);
    const view = await renderScreen(<TodayScreen />, {
      me: makeMe({ isOwner: true, permissions: [] })
    });
    await waitFor(() => expect(view.getByLabelText("Start service")).toBeTruthy());
  });
});

describe("Today — connectivity", () => {
  it("disables the primary offline but keeps its label, and says why", async () => {
    // Status changes are never queued: they advance a server-owned state machine ordered against
    // other staff's actions.
    mocked.appointments.mockResolvedValue([makeAppointment({ status: "checked_in" })]);
    const view = await renderScreen(<TodayScreen />, { online: false });
    await waitFor(() => expect(view.getByTestId("now-primary")).toBeTruthy());
    expect(view.getByLabelText("Start service")).toBeTruthy();
    expect(view.getByText("Offline — reconnect to start service.")).toBeTruthy();
    expect(mocked.transition).not.toHaveBeenCalled();
  });

  it("keeps showing cached appointments behind an offline banner", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment()]);
    const view = await renderScreen(<TodayScreen />, { online: false });
    await waitFor(() => expect(view.getByTestId("offline-banner")).toBeTruthy());
    expect(view.getByText("Biscuit")).toBeTruthy();
  });
});

describe("Today — navigation", () => {
  it("opens the appointment when a card is tapped", async () => {
    mocked.appointments.mockResolvedValue([makeAppointment({ id: "a" }), makeAppointment({ id: "b" })]);
    const view = await renderScreen(<TodayScreen />);
    await waitFor(() => expect(view.getByTestId("appointment-b")).toBeTruthy());
    await fireEvent.press(view.getByTestId("appointment-b"));
    expect(mockPush).toHaveBeenCalledWith("/appointment/b");
  });
});
