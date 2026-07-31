import { describe, expect, it } from "vitest";
import { formatWallTime, localDateBounds, parseLocalDateTime, resolveWallTime, validateTimeZone, WallTimeError } from "../../src/domain/time.js";

describe("authoritative scheduling time", () => {
  it("validates zones and strict local syntax", () => {
    expect(validateTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(() => validateTimeZone("Not/A_Zone")).toThrow(WallTimeError);
    expect(parseLocalDateTime("2028-02-29T09:30")).toMatchObject({year:2028,month:2,day:29,hour:9,minute:30});
    for (const invalid of ["2027-02-29T09:30","2028-02-29T24:00","2028-02-29T09:30:00","2028-02-29T09:30Z"," 2028-02-29T09:30"])
      expect(() => parseLocalDateTime(invalid)).toThrow(WallTimeError);
  });

  it("rejects nonexistent time and distinguishes both repeated occurrences", () => {
    expect(() => resolveWallTime("2026-03-08T02:30","America/Los_Angeles")).toThrowError(expect.objectContaining({code:"NONEXISTENT_LOCAL_TIME"}));
    expect(() => resolveWallTime("2026-11-01T01:30","America/Los_Angeles")).toThrowError(expect.objectContaining({code:"AMBIGUOUS_LOCAL_TIME"}));
    const earlier=resolveWallTime("2026-11-01T01:30","America/Los_Angeles","earlier");
    const later=resolveWallTime("2026-11-01T01:30","America/Los_Angeles","later");
    expect(earlier.instant.toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(later.instant.toISOString()).toBe("2026-11-01T09:30:00.000Z");
    expect(formatWallTime(earlier.instant,earlier.timeZone)).toBe("2026-11-01T01:30");
  });

  it("builds 23-hour and 25-hour local days", () => {
    const spring=localDateBounds("2026-03-08","America/Los_Angeles");
    const fall=localDateBounds("2026-11-01","America/Los_Angeles");
    expect((spring.to.getTime()-spring.from.getTime())/3_600_000).toBe(23);
    expect((fall.to.getTime()-fall.from.getTime())/3_600_000).toBe(25);
  });
});
