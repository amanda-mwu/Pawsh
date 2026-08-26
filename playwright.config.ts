import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(".playwright-browsers");
const baseURL = process.env.PAWSH_E2E_BASE_URL ?? "http://127.0.0.1:3000";
// The browser, web server, CORS policy, and mutation-origin check must agree on
// one exact origin. Preserve an explicit caller value, but make local
// Playwright runs self-contained instead of relying on a matching shell value.
process.env.APP_ORIGIN ||= new URL(baseURL).origin;
const crossBrowserTag = /@cross-browser/;
const mobileTag = /@mobile-core|@responsive/;
const tabletTag = /@tablet-core|@responsive/;

export default defineConfig({
  testDir:"tests/e2e",
  testIgnore:"p1-document-scanning/**",
  fullyParallel:true,
  // A missed navigation event or a click that never settles on a contended runner does not
  // reproduce; a retry absorbs it, and Playwright still reports the test as flaky so the
  // instability stays visible rather than silently passing.
  retries:process.env.CI ? 2 : 0,
  // Local runs share ONE disposable server+database across all workers, so the
  // Playwright default (half the CPU cores) starves navigation. Every project
  // except "chromium" already pins workers:1; encoding the supported local
  // concurrency here covers that project and any future unpinned one.
  // CI is unchanged: each job owns its own server and database container.
  workers:process.env.CI ? 2 : 1,
  timeout:30_000,
  expect:{timeout:5_000},
  reporter:process.env.CI ? [["github"],["html",{open:"never"}]] : "list",
  outputDir:"test-results",
  use:{
    baseURL,
    timezoneId:"America/Los_Angeles",
    locale:"en-US",
    // "retain-on-failure" records every test and throws the artifact away when it passes, so
    // the whole suite pays for tracing and screencasting on the happy path. Capturing on the
    // retry instead keeps identical evidence for anything that actually fails.
    trace:"on-first-retry",
    screenshot:"only-on-failure",
    video:"on-first-retry"
  },
  webServer:process.env.PAWSH_E2E_BASE_URL ? undefined : {
    // Launch Node directly. On Windows, the npm.cmd wrapper can exit without
    // terminating its server child, leaving Playwright stuck in teardown after
    // the browser and context have already closed.
    command:"node --import ./scripts/load-env.mjs --import tsx src/server.ts",
    url:`${baseURL}/health`,
    reuseExistingServer:!process.env.CI,
    timeout:30_000
  },
  projects:[
    {
      name:"chromium",
      use:{...devices["Desktop Chrome"]}
    },
    {
      name:"firefox-desktop",
      grep:crossBrowserTag,
      workers:1,
      use:{...devices["Desktop Firefox"]}
    },
    {
      name:"webkit-desktop",
      grep:crossBrowserTag,
      workers:1,
      use:{...devices["Desktop Safari"]}
    },
    {
      name:"iphone-webkit",
      grep:mobileTag,
      workers:1,
      use:{...devices["iPhone 15"]}
    },
    {
      name:"android-chromium",
      grep:mobileTag,
      workers:1,
      use:{...devices["Pixel 7"]}
    },
    {
      name:"ipad-webkit",
      grep:tabletTag,
      workers:1,
      use:{...devices["iPad (gen 11)"]}
    },
    {
      name:"chromium-security",
      grep:/@security-desktop|@security-permission-parity/,
      workers:1,
      use:{...devices["Desktop Chrome"]}
    },
    {
      name:"chromium-regression",
      grep:/@regression-booking|@regression-lifecycle|@regression-crm-history|@regression-pet-documents|@regression-checkout|@regression-calendar-time|@regression-scheduling-replay/,
      workers:1,
      use:{...devices["Desktop Chrome"]}
    },
    {
      name:"iphone-security",
      grep:/@security-permission-parity/,
      workers:1,
      use:{...devices["iPhone 15"]}
    }
  ]
});
