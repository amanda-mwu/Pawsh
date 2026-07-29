import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(".playwright-browsers");
const baseURL = process.env.PAWSH_E2E_BASE_URL ?? "http://127.0.0.1:3000";
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
    command:"npm run start:e2e",
    url:`${baseURL}/health`,
    reuseExistingServer:!process.env.CI,
    timeout:30_000
  },
  projects:[
    {
      name:"chromium-desktop",
      use:{...devices["Desktop Chrome"]}
    },
    {
      name:"firefox-desktop",
      grep:crossBrowserTag,
      use:{...devices["Desktop Firefox"]}
    },
    {
      name:"webkit-desktop",
      grep:crossBrowserTag,
      use:{...devices["Desktop Safari"]}
    },
    {
      name:"iphone-webkit",
      grep:mobileTag,
      use:{...devices["iPhone 15"]}
    },
    {
      name:"android-chromium",
      grep:mobileTag,
      use:{...devices["Pixel 7"]}
    },
    {
      name:"ipad-webkit",
      grep:tabletTag,
      use:{...devices["iPad (gen 11)"]}
    }
  ]
});
