import {
  addOnServiceCategories,
  appointmentPrimaryActions,
  groomerHashSlotCount,
  groomerPaletteSize,
  groomerSlotIndex,
  permissionForTransition,
  resolveAppointmentBadge,
  splitAppointmentServices
} from "@pawsh/domain";
import { groomerSlots } from "../../src/theme/tokens";

/**
 * The web app's own implementation, transcribed from `public/app.js`.
 *
 * Kept here as a fixture rather than imported so that a change to the shared function is caught
 * as a divergence from the browser rather than silently agreeing with itself.
 */
function webGroomerSlot(id: string): number | "" {
  if (!id) return "";
  let hash = 0;
  const key = String(id);
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % 5;
}

describe("groomer identity", () => {
  it("assigns the same slot the web calendar does", () => {
    // A groomer who is purple on the web calendar and orange on a phone is two people to anyone
    // reading both.
    const ids = [
      "employee-1",
      "5f8d0d55-b2f4-4c9a-9c0e-2f5c9d1c2b3a",
      "maya",
      "0",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    ];
    for (const id of ids) {
      expect(groomerSlotIndex(id)).toBe(webGroomerSlot(id));
    }
  });

  it("has no slot for an unassigned appointment", () => {
    expect(groomerSlotIndex(null)).toBeNull();
    expect(groomerSlotIndex("")).toBeNull();
  });

  it("has a colour for every slot the palette can store", () => {
    // A slot assigned on the Staff screen reaches this array directly, so the tokens have to
    // cover the whole palette, not just the five the hash can deal. The hash floor is asserted
    // separately: a slot the hash CAN produce losing its colour is the worse regression.
    expect(groomerSlots.length).toBe(groomerPaletteSize);
    expect(groomerSlots.length).toBeGreaterThanOrEqual(groomerHashSlotCount);
  });
});

describe("badge precedence", () => {
  it("prefers the payment badge once an invoice exists", () => {
    expect(resolveAppointmentBadge({ status: "completed", invoiceStatus: "paid" })).toMatchObject({
      code: "PAI"
    });
  });

  it("reads every unsettled invoice status as unpaid", () => {
    for (const status of ["open", "partially_paid", "draft", "void"] as const) {
      expect(resolveAppointmentBadge({ status: "completed", invoiceStatus: status })).toMatchObject(
        { code: "UNP" }
      );
    }
  });

  it("returns null rather than inventing a state the API cannot back", () => {
    expect(resolveAppointmentBadge({ status: "confirmed", invoiceStatus: null })).toBeNull();
    expect(resolveAppointmentBadge({ status: null })).toBeNull();
  });
});

describe("service split", () => {
  it("treats only the add-on families as add-ons", () => {
    expect([...addOnServiceCategories].sort()).toEqual(["A_LA_CARTE", "DOG_ADDON"]);
  });

  it("leads with the longest service when the catalog is unknown", () => {
    const split = splitAppointmentServices(
      [
        { serviceId: "a", name: "Nail trim", durationMinutes: 10 },
        { serviceId: "b", name: "Full Groom", durationMinutes: 90 }
      ],
      () => null
    );
    expect(split.primary).toBe("Full Groom");
    expect(split.addOns).toEqual(["Nail trim"]);
  });

  it("prefers a base service over a longer add-on", () => {
    const split = splitAppointmentServices(
      [
        { serviceId: "long-addon", name: "De-shed treatment", durationMinutes: 120 },
        { serviceId: "base", name: "Bath", durationMinutes: 30 }
      ],
      (id) => (id === "long-addon" ? "DOG_ADDON" : "DOG_BASE")
    );
    expect(split.primary).toBe("Bath");
  });

  it("handles an appointment with no service lines", () => {
    expect(splitAppointmentServices([], () => null)).toEqual({ primary: "", addOns: [] });
  });
});

describe("transition permissions", () => {
  it("derives the permission from the target status, as the server does", () => {
    expect(permissionForTransition("checked_in")).toBe("operations.check_in");
    expect(permissionForTransition("in_service")).toBe("operations.perform_service");
    expect(permissionForTransition("completed")).toBe("operations.complete");
    expect(permissionForTransition("cancelled")).toBe("appointments.cancel");
    expect(permissionForTransition("no_show")).toBe("appointments.cancel");
  });

  it("keeps the primary action's permission in step with its target", () => {
    for (const action of Object.values(appointmentPrimaryActions)) {
      if (!action?.target) continue;
      expect(action.permission).toBe(permissionForTransition(action.target));
    }
  });
});
