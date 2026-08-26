import {
  findNowAppointment,
  isAssignedTo,
  isTerminal,
  toAppointmentView
} from "../../src/features/appointments/model";
import { planPrimaryAction } from "../../src/features/appointments/transition";
import {
  formatLongDate,
  formatRange,
  formatShortDate,
  parseLocalDateTime,
  shiftDate
} from "../../src/features/appointments/time";
import { resolveSafetyState } from "../../src/components/SafetyAlarm";
import { makeAppointment } from "../support/fixtures";

const visible = { careVisibility: "visible" } as const;

describe("wall-clock formatting", () => {
  it("reads the naive local timestamp rather than converting a UTC instant", () => {
    // Hermes ships a reduced ICU whose named-timezone support is not dependable, and a groomer
    // reading 9:00 for a 10:00 appointment is worse than any amount of formatting elegance.
    expect(parseLocalDateTime("2026-08-26T09:00")).toEqual({
      date: "2026-08-26",
      hour: 9,
      minute: 0
    });
  });

  it("states the meridiem once when both ends share it", () => {
    expect(formatRange({ date: "2026-08-26", hour: 9, minute: 0 }, 90)).toBe("9:00 – 10:30 AM");
  });

  it("keeps both when the range crosses noon", () => {
    expect(formatRange({ date: "2026-08-26", hour: 11, minute: 30 }, 90)).toBe(
      "11:30 AM – 1:00 PM"
    );
  });

  it("names the weekday and month in full English", () => {
    expect(formatLongDate("2026-08-26")).toBe("Wednesday, August 26");
    expect(formatShortDate("2026-08-26")).toBe("Wed, Aug 26");
  });

  it("shifts a date across a month boundary", () => {
    expect(shiftDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDate("2026-09-01", -1)).toBe("2026-08-31");
  });
});

describe("toAppointmentView", () => {
  it("derives the time range and duration from the location's wall clock", () => {
    const view = toAppointmentView(makeAppointment(), visible);
    expect(view.timeRange).toBe("9:00 – 10:30 AM");
    expect(view.durationMinutes).toBe(90);
    expect(view.localDate).toBe("2026-08-26");
  });

  it("shows the lifecycle badge while there is no invoice", () => {
    const view = toAppointmentView(makeAppointment({ status: "in_service" }), visible);
    expect(view.badge).toMatchObject({ code: "SVC", label: "In service", kind: "lifecycle" });
  });

  it("lets the payment badge replace the lifecycle badge once an invoice exists", () => {
    const paid = toAppointmentView(
      makeAppointment({ status: "completed", invoiceStatus: "paid" }),
      visible
    );
    expect(paid.badge).toMatchObject({ code: "PAI", kind: "payment" });

    const open = toAppointmentView(
      makeAppointment({ status: "completed", invoiceStatus: "open" }),
      visible
    );
    expect(open.badge).toMatchObject({ code: "UNP", kind: "payment" });
  });

  it("renders no badge for a status the API cannot back, rather than a grey Unknown", () => {
    const view = toAppointmentView(
      makeAppointment({ status: "confirmed" as never }),
      visible
    );
    expect(view.badge).toBeNull();
  });

  it("flags rabies on the wider four-state set the detail panel uses", () => {
    for (const status of ["not_provided", "expires_before_appointment", "expired"] as const) {
      const view = toAppointmentView(
        makeAppointment({ rabiesAppointmentStatus: status }),
        visible
      );
      expect(view.rabiesNeeded).toBe(true);
    }
    const current = toAppointmentView(
      makeAppointment({ rabiesAppointmentStatus: "valid_for_appointment" }),
      visible
    );
    expect(current.rabiesNeeded).toBe(false);
    expect(current.rabiesLabel).toBe("Valid for appointment");
  });

  it("leads with the base service and greys the add-ons behind it", () => {
    const view = toAppointmentView(
      makeAppointment({
        services: [
          { id: "l1", serviceId: "s-addon", name: "Nail trim", durationMinutes: 10, priceMinor: 1500 },
          { id: "l2", serviceId: "s-base", name: "Full Groom", durationMinutes: 90, priceMinor: 8500 }
        ]
      }),
      {
        careVisibility: "visible",
        categoryOf: (id) => (id === "s-addon" ? "DOG_ADDON" : "DOG_BASE")
      }
    );
    expect(view.services.primary).toBe("Full Groom");
    expect(view.services.addOns).toEqual(["Nail trim"]);
  });

  it("totals prices in the business currency", () => {
    const view = toAppointmentView(makeAppointment(), { careVisibility: "visible", currency: "USD" });
    expect(view.totalPriceLabel).toBe("$85.00");
  });

  it("carries the assignment so a Mine filter needs no second lookup", () => {
    const view = toAppointmentView(makeAppointment(), visible);
    expect(isAssignedTo(view, "employee-1")).toBe(true);
    expect(isAssignedTo(view, "employee-2")).toBe(false);
  });
});

describe("safety state", () => {
  it("says an alert is present", () => {
    expect(resolveSafetyState({ care: "visible", safetyAlerts: "Bites when clipped" })).toEqual({
      kind: "alert",
      text: "Bites when clipped"
    });
  });

  it("asserts absence rather than rendering nothing", () => {
    expect(resolveSafetyState({ care: "visible", safetyAlerts: null })).toEqual({ kind: "clear" });
  });

  it("distinguishes withheld from absent, because a redacted field looks identical", () => {
    expect(resolveSafetyState({ care: "withheld", safetyAlerts: null })).toEqual({
      kind: "withheld"
    });
  });

  it("never reports a failed care fetch as safe", () => {
    expect(
      resolveSafetyState({ care: "visible", failed: true, safetyAlerts: null })
    ).toEqual({ kind: "unavailable" });
  });

  it("holds the slot while care data is still arriving", () => {
    expect(resolveSafetyState({ care: "visible", loading: true, safetyAlerts: null })).toEqual({
      kind: "loading"
    });
  });
});

describe("planPrimaryAction", () => {
  const allowAll = () => true;
  const allowNone = () => false;

  it("offers the transition the current status permits", () => {
    expect(planPrimaryAction(toAppointmentView(makeAppointment(), visible), allowAll)).toMatchObject(
      { label: "Check in", target: "checked_in", available: true }
    );
    expect(
      planPrimaryAction(
        toAppointmentView(makeAppointment({ status: "checked_in" }), visible),
        allowAll
      )
    ).toMatchObject({ label: "Start service", target: "in_service" });
    expect(
      planPrimaryAction(
        toAppointmentView(makeAppointment({ status: "in_service" }), visible),
        allowAll
      )
    ).toMatchObject({ label: "Complete", target: "completed" });
  });

  it("removes the action when the permission is missing rather than disabling it", () => {
    // This is presentation. The server derives the same permission from the target status and
    // refuses independently; that refusal is the one that authorizes anything.
    expect(planPrimaryAction(toAppointmentView(makeAppointment(), visible), allowNone)).toBeNull();
  });

  it("marks checkout unavailable, because this release does not take payment", () => {
    const plan = planPrimaryAction(
      toAppointmentView(makeAppointment({ status: "completed" }), visible),
      allowAll
    );
    expect(plan).toMatchObject({ label: "Checkout", available: false });
  });

  it("offers nothing from a terminal status", () => {
    for (const status of ["cancelled", "no_show"] as const) {
      expect(
        planPrimaryAction(toAppointmentView(makeAppointment({ status }), visible), allowAll)
      ).toBeNull();
    }
  });
});

describe("list shaping", () => {
  it("treats cancelled, no-show and completed as finished work", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("no_show")).toBe(true);
    expect(isTerminal("checked_in")).toBe(false);
  });

  it("promotes whatever is on the table", () => {
    const views = [
      toAppointmentView(makeAppointment({ id: "a", status: "scheduled" }), visible),
      toAppointmentView(makeAppointment({ id: "b", status: "in_service" }), visible)
    ];
    expect(findNowAppointment(views)?.id).toBe("b");
  });
});
