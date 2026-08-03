import { describe, expect, it } from "vitest";
import { parseVersion, validateRuntimePolicy } from "../../scripts/runtime-policy.mjs";

describe("runtime policy", () => {
  it.each(["22.0.0", "22.23.1", "24.0.0", "24.18.0"])("accepts supported stable Node %s", (node) => {
    expect(validateRuntimePolicy(node, "11.6.0")).toEqual({ valid: true, reason: null });
  });

  it.each(["21.9.0", "23.0.0", "25.0.0", "26.1.0", "22.0.0-rc.1", "24.0.0-nightly", "invalid"])(
    "rejects unsupported Node %s", (node) => expect(validateRuntimePolicy(node, "11.6.0").valid).toBe(false)
  );

  it.each(["10.9.0", "12.0.0", "11.6.0-beta.1", "invalid"])(
    "rejects unsupported npm %s", (npm) => expect(validateRuntimePolicy("24.0.0", npm).valid).toBe(false)
  );

  it("parses stable and prerelease versions deliberately", () => {
    expect(parseVersion("24.1.2")).toMatchObject({ major: 24, prerelease: null });
    expect(parseVersion("24.1.2-rc.1")).toMatchObject({ major: 24, prerelease: "rc.1" });
    expect(parseVersion("v24.1.2")).toBeNull();
  });
});
