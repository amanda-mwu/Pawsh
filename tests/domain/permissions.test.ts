import { describe, expect, it } from "vitest";
import { can } from "@pawsh/domain";

describe("permissions", () => {
  it("gives owners protected full access", () => {
    expect(can({ isOwner: true, permissions: [] }, "settings.manage")).toBe(true);
  });

  it("requires explicit permission for non-owners", () => {
    expect(can({ isOwner: false, permissions: ["calendar.view"] }, "calendar.view")).toBe(true);
    expect(can({ isOwner: false, permissions: ["calendar.view"] }, "team.manage")).toBe(false);
    expect(can(
      { isOwner: false, permissions: ["appointments.create"] },
      "appointments.override_conflict"
    )).toBe(false);
    expect(can(
      { isOwner: false, permissions: ["appointments.override_conflict"] },
      "appointments.override_conflict"
    )).toBe(true);
  });
});
