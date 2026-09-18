import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import { openBooking, chooseBookingClient, chooseBookingPet, expandBookingServices } from "./helpers/booking.js";
import { elementPixels, pixelAt, luminance, colorDistance, type Pixels } from "./helpers/pixels.js";
import type { Locator, Page } from "@playwright/test";

/**
 * THE TICK, AS PAINTED.
 *
 * Human QA reported the selected-state check mark "inverted" twice. The first fix recoloured the
 * colour-swatch tick for contrast and the report came back unchanged, because the defect was not
 * the colour: the mark was two borders of a SQUARE box turned 45 degrees, so its arms were the same
 * length and it read as a symmetrical "v" - the product's own expand chevron, pointing the wrong
 * way. A tick has a short arm and a long one rising to the right. No computed style says which of
 * those shapes is on the screen, so this file reads the pixels back and asks:
 *
 *   THE SWATCH TICK IS A TICK. Its topmost ink is on the right of the disc (the long arm reaches
 *       highest), its lowest ink is left of centre (the vertex), and it reaches further right of
 *       centre than left. A symmetrical chevron fails the first and the third; a mirrored tick
 *       fails all three.
 *   THE NATIVE CHECKBOX IS FILLED WITH THE BRAND AND TICKED IN WHITE, in the light scheme and
 *       under `colorScheme: "dark"` alike. The page declares no `color-scheme`, so a checked box
 *       must not come back dark-on-dark or white-on-white whichever way the device is set.
 *   THE SELECTED SERVICE ROW STAYS LIGHT. `.compact-options label:has(input:checked)` is a tint
 *       with dark text, never an inverted block.
 *
 * `@responsive`, so the iPhone and Pixel projects render it too: WebKit's checkbox is not
 * Chromium's, and it is WebKit the QA phone was running.
 */

async function openCalendar(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

/** Ink pixels inside the disc, keeping clear of the 2px ring and of anti-aliasing at its edge. */
function inkInsideDisc(pixels: Pixels): Array<[number, number]> {
  const centreX = pixels.width / 2, centreY = pixels.height / 2;
  const radius = Math.min(centreX, centreY) - 4 * pixels.scale;
  const ink: Array<[number, number]> = [];
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY) > radius) continue;
      if (luminance(pixelAt(pixels, x, y)) < 0.3) ink.push([x, y]);
    }
  }
  return ink;
}

async function expectTickShape(page: Page, dot: Locator, what: string): Promise<void> {
  const pixels = await elementPixels(page, dot);
  const ink = inkInsideDisc(pixels);
  const centreX = pixels.width / 2;
  expect(ink.length, `${what}: a tick was drawn`).toBeGreaterThan(6 * pixels.scale);
  const top = Math.min(...ink.map(([, y]) => y));
  const bottom = Math.max(...ink.map(([, y]) => y));
  const highest = ink.filter(([, y]) => y <= top + pixels.scale);
  const lowest = ink.filter(([, y]) => y >= bottom - pixels.scale);
  // The two arms, split at the vertex's column rather than at the disc's centre: everything left
  // of the lowest ink is the short arm, everything right of it the long one.
  const vertexX = lowest.reduce((sum, [x]) => sum + x, 0) / lowest.length;
  const leftArmTop = Math.min(...ink.filter(([x]) => x < vertexX - pixels.scale).map(([, y]) => y));
  const rightArmTop = Math.min(...ink.filter(([x]) => x > vertexX + pixels.scale).map(([, y]) => y));
  // The long arm reaches highest, and it is on the right.
  expect(highest.every(([x]) => x > centreX), `${what}: the topmost ink is all right of centre`).toBe(true);
  // The vertex - the lowest ink - sits left of centre.
  expect(lowest.every(([x]) => x < centreX + pixels.scale), `${what}: the vertex is left of centre`).toBe(true);
  // A tick is asymmetric: the right arm rises clearly higher than the left. A chevron's arms rise
  // to the same height, and a mirrored tick's left arm is the taller.
  expect(leftArmTop - rightArmTop, `${what}: the right arm rises higher than the left`).toBeGreaterThanOrEqual(2 * pixels.scale);
}

/** A checked native checkbox: brand fill, light tick, measured on the pixels. */
async function expectBrandCheckbox(page: Page, box: Locator, what: string): Promise<void> {
  const pixels = await elementPixels(page, box);
  const brand: [number, number, number] = [47, 111, 98];
  let brandish = 0, light = 0, total = 0;
  const inset = Math.round(2 * pixels.scale);
  for (let y = inset; y < pixels.height - inset; y += 1) {
    for (let x = inset; x < pixels.width - inset; x += 1) {
      const rgb = pixelAt(pixels, x, y);
      total += 1;
      if (colorDistance(rgb, brand) < 70) brandish += 1;
      else if (luminance(rgb) > 0.75) light += 1;
    }
  }
  expect(brandish / total, `${what}: the box is filled with the brand colour`).toBeGreaterThan(0.4);
  expect(light / total, `${what}: the tick is drawn light on it`).toBeGreaterThan(0.03);
  expect(light / total, `${what}: it is not a white box`).toBeLessThan(0.5);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@responsive the colour swatch tick is a tick and not a chevron (${scheme})`, async ({ page, request, tenant }) => {
      await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
      await login(page, tenant.ownerEmail);
      await openCalendar(page);
      await page.getByTestId("new-action-trigger").click();
      await page.getByTestId("new-action-menu").getByRole("menuitem", { name: "New Block Time" }).click();
      const swatches = page.locator(".staff-swatch");
      await expect(swatches.first()).toBeVisible();
      // The unset swatch is chosen by default and draws the tick on a hatched, uncoloured disc.
      await expectTickShape(page, page.locator(".staff-swatch:has(input:checked) .staff-swatch-dot"), "no-colour swatch");
      // A coloured swatch draws the same mark in its own darkened ink on its own tint.
      await swatches.nth(1).click();
      await expect(swatches.nth(1).locator("input")).toBeChecked();
      await expectTickShape(page, swatches.nth(1).locator(".staff-swatch-dot"), "coloured swatch");
      // And one that was ruled out by the first fix's arithmetic: Amber, the palette's floor.
      const amber = page.locator(".staff-swatch", { has: page.locator('[data-groomer-slot="3"]') });
      await amber.click();
      await expectTickShape(page, amber.locator(".staff-swatch-dot"), "amber swatch");
    });

    test(`@responsive native checkboxes are brand-filled with a light tick (${scheme})`, async ({ page, request, tenant }) => {
      await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
      await login(page, tenant.ownerEmail);
      await openCalendar(page);

      // The groomer filter: one checked groomer.
      await page.locator("#groomer-filter-trigger").click();
      const groomerBox = page.locator("#groomer-filter-options input[type=checkbox]").first();
      await expect(groomerBox).toBeChecked();
      await expectBrandCheckbox(page, groomerBox, "groomer filter");
      await page.keyboard.press("Escape");
      if (await page.locator("#groomer-filter").getAttribute("open") !== null) await page.locator("#groomer-filter-trigger").click();

      // The service picker: the chosen service's box, and the row it sits in.
      await openBooking(page);
      await chooseBookingClient(page, tenant.customerId);
      await chooseBookingPet(page, tenant.petId);
      await expandBookingServices(page);
      const service = page.getByRole("checkbox", { name: /Full Groom/ });
      await service.setChecked(true);
      // Blur first: a focus ring around the box would be counted as ink.
      await page.locator("#booking-dialog h2, #booking-title").first().click({ force: true }).catch(() => {});
      await expectBrandCheckbox(page, service, "service picker");
      const row = await service.evaluate((element) => {
        const label = element.closest("label");
        if (!label) throw new Error("the service checkbox is not inside its row");
        const style = getComputedStyle(label);
        return { background: style.backgroundColor, color: style.color };
      });
      const parse = (value: string): [number, number, number] => {
        const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      };
      expect(luminance(parse(row.background)), "the selected row is a light tint").toBeGreaterThan(0.8);
      expect(luminance(parse(row.color)), "the selected row's text is dark").toBeLessThan(0.2);
    });
  });
}
