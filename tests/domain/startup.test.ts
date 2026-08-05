import { describe, expect, it, vi } from "vitest";
import { browserLaunchCommand } from "../../src/default-browser.js";
import {
  formatBoundAddress,
  lifecycleLoggingEnabled,
  startupFailureMessage,
  writeLifecycleLog
} from "../../src/startup.js";

describe("startup developer experience", () => {
  it("keeps lifecycle output suppressed for deterministic test runtime", () => {
    expect(lifecycleLoggingEnabled("test")).toBe(false);
    expect(lifecycleLoggingEnabled("development")).toBe(true);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    writeLifecycleLog(false, "READY", "Pawsh listening", { token: "must-not-appear" });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("formats bound listeners independently from APP_ORIGIN", () => {
    expect(formatBoundAddress({ address: "0.0.0.0", family: "IPv4", port: 3000 })).toBe("0.0.0.0:3000");
    expect(formatBoundAddress({ address: "::", family: "IPv6", port: 3000 })).toBe("[::]:3000");
  });

  it("uses the native default-browser launcher on each supported platform", () => {
    const url = "http://127.0.0.1:3000";
    expect(browserLaunchCommand(url, "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", url]
    });
    expect(browserLaunchCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserLaunchCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });

  it("classifies startup failures without rendering raw connection details", () => {
    expect(startupFailureMessage(Object.assign(new Error("postgres://user:secret@example.test/pawsh"), {
      code: "ECONNREFUSED"
    }))).toBe("PostgreSQL connection failed");
    expect(startupFailureMessage(Object.assign(new Error("invalid"), { name: "ZodError" }))).toBe(
      "Configuration validation failed"
    );
  });
});
