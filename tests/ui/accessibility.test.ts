import { HtmlValidate } from "html-validate";
import { describe, expect, it } from "vitest";

describe("web client accessibility baseline", () => {
  it("uses valid, labeled, structurally accessible HTML", async () => {
    const validator = new HtmlValidate({
      extends: ["html-validate:recommended"],
      rules: {
        "no-inline-style": "error",
        "wcag/h30": "error",
        "wcag/h32": "error",
        "wcag/h37": "error",
        "wcag/h67": "error",
        "wcag/h71": "error"
      }
    });
    const report = await validator.validateFile("public/index.html");
    expect(report.results.flatMap((result) => result.messages)).toEqual([]);
    expect(report.valid).toBe(true);
  });
});
