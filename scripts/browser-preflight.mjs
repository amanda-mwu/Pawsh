/* global console */
import process from "node:process";
import { chromium, firefox, webkit } from "@playwright/test";

const browsers = { chromium, firefox, webkit };
const name = process.argv[2];
if (!name || !browsers[name]) throw new Error(`Unknown browser preflight: ${name}`);
const browser = await browsers[name].launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  await context.close();
} finally {
  await browser.close();
}
console.log(`Browser preflight passed: ${name}`);
