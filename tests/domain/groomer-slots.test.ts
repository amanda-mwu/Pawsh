import { describe, expect, it } from "vitest";
import { groomerHashSlotCount, groomerPaletteSize, groomerSlotIndex, resolveGroomerSlot } from "@pawsh/domain";

/**
 * Two numbers that look like one, and must never be folded back together.
 *
 * `groomerPaletteSize` is how many identity colours exist, and therefore the ceiling on a slot an
 * operator may store. `groomerHashSlotCount` is the modulus of the fallback that colours every
 * groomer nobody has assigned one - which is every groomer in every workspace that has not opened
 * the Staff screen. Raising the modulus does not give those people more colours, it redeals the
 * ones they have: over 200,000 ids, moving 5 to 10 recolours a little over half of them.
 *
 * These assertions exist so that a future "tidy-up" that unifies the constants fails here, loudly,
 * instead of quietly reshuffling the colour of every groomer in production.
 */
describe("groomer identity slots", () => {
  it("keeps the hash modulus at five, whatever the palette grows to", () => {
    expect(groomerHashSlotCount).toBe(5);
    expect(groomerPaletteSize).toBeGreaterThanOrEqual(groomerHashSlotCount);
  });

  it("never deals a hash slot outside the first five", () => {
    for (let index = 0; index < 2000; index += 1) {
      const slot = groomerSlotIndex(crypto.randomUUID());
      expect(slot).not.toBeNull();
      expect(slot!).toBeGreaterThanOrEqual(0);
      expect(slot!).toBeLessThan(groomerHashSlotCount);
    }
  });

  /**
   * The exact hash the web calendar and the mobile app both reproduce. Transcribed rather than
   * imported: a change to the shared function has to show up here as a divergence from the
   * browser rather than silently agreeing with itself.
   */
  function webGroomerSlot(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
      hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return hash % 5;
  }

  it("still assigns the slot the browser assigns", () => {
    for (const id of [
      "employee-1", "5f8d0d55-b2f4-4c9a-9c0e-2f5c9d1c2b3a", "maya", "0",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    ]) {
      expect(groomerSlotIndex(id)).toBe(webGroomerSlot(id));
    }
  });

  it("lets an assigned slot reach the whole palette, not just the hash range", () => {
    const id = "5f8d0d55-b2f4-4c9a-9c0e-2f5c9d1c2b3a";
    for (let slot = 0; slot < groomerPaletteSize; slot += 1) {
      expect(resolveGroomerSlot(id, slot)).toBe(slot);
    }
  });

  it("falls back to the hash for an unassigned or unrenderable slot", () => {
    const id = "5f8d0d55-b2f4-4c9a-9c0e-2f5c9d1c2b3a";
    const hashed = groomerSlotIndex(id);
    // Null is the state of every employee nobody has assigned a colour, which must keep the hash.
    expect(resolveGroomerSlot(id, null)).toBe(hashed);
    expect(resolveGroomerSlot(id, undefined)).toBe(hashed);
    // The database check allows 0-15 so the palette can grow without a migration; a slot stored
    // while the palette was larger asks for a token that is not there, so the hash answers.
    expect(resolveGroomerSlot(id, groomerPaletteSize)).toBe(hashed);
    expect(resolveGroomerSlot(id, 15)).toBe(hashed);
    expect(resolveGroomerSlot(id, -1)).toBe(hashed);
    expect(resolveGroomerSlot(id, 1.5)).toBe(hashed);
  });
});
