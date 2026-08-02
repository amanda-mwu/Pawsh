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
  fullyParallel:true,
  retries:0,
  workers:process.env.CI ? 2 : undefined,
  timeout:30_000,
  expect:{timeout:5_000},
  reporter:process.env.CI ? [["github"],["html",{open:"never"}]] : "list",
  outputDir:"test-results",
  use:{
    baseURL,
    timezoneId:"America/Los_Angeles",
    locale:"en-US",
    trace:"retain-on-failure",
    screenshot:"only-on-failure",
    video:"retain-on-failure"
  },
  webServer:process.env.PAWSH_E2E_BASE_URL ? undefined : {
    // Launch Node directly. On Windows, the npm.cmd wrapper can exit without
    // terminating its server child, leaving Playwright stuck in teardown after
    // the browser and context have already closed.
    command:"node --env-file-if-exists=.env --import tsx src/server.ts",
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
