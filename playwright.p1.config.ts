import { defineConfig,devices } from "@playwright/test";
import { resolve } from "node:path";
process.env.PLAYWRIGHT_BROWSERS_PATH||=resolve(".playwright-browsers");
const baseURL=process.env.PAWSH_E2E_BASE_URL;
if(!baseURL||process.env.PAWSH_E2E_MODE!=="disposable"||!process.env.PAWSH_P1_RUN_ID) {
  throw new Error("P1 Playwright requires an external disposable environment and run ID");
}
export default defineConfig({
  testDir:"tests/e2e/p1-document-scanning",fullyParallel:false,workers:1,retries:0,timeout:60_000,
  expect:{timeout:10_000},reporter:process.env.CI?[["github"],["html",{open:"never",outputFolder:"playwright-report/p1"}]]:"list",
  outputDir:"test-results/p1",use:{baseURL,timezoneId:"America/Los_Angeles",locale:"en-US",trace:"retain-on-failure",
    screenshot:"only-on-failure",video:"retain-on-failure"},
  projects:[{name:"p1-document-scanning-chromium",use:{...devices["Desktop Chrome"]}}]
});
