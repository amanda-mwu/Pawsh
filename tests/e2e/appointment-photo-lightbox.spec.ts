import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import type { Locator, Page } from "@playwright/test";
import { decodablePng } from "../support/images.js";
import { revealAppointmentOnCalendar } from "./helpers/calendar.js";
import { expectTouchTarget } from "./helpers/responsive.js";

/**
 * PRESS THE PHOTO, SEE THE PHOTO, PRESS X TO COME BACK.
 *
 * The appointment surface drew 118px thumbnails and nothing happened when one was pressed. Now
 * a tile is a button that opens the photo full size in a <dialog> over the surface - the same
 * URL the tile loaded, the same alt text - and X, Escape and the dialog's own close all put focus
 * back on the tile that opened it.
 *
 * What only a browser can hold: that the dialog is modal over the appointment surface and the
 * surface is still there underneath; that the full-size image decoded off the same read; that the
 * focus contract holds through a real keyboard; and that the close target is a thumb's size on a
 * coarse pointer.
 */

const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");
const lightbox = (page: Page): Locator => page.getByTestId("photo-lightbox");

async function openWithPhoto(page: Page, request: Parameters<typeof createAppointment>[0], tenant: Parameters<typeof createAppointment>[1]): Promise<Locator> {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await login(page, tenant.ownerEmail);
  // A phone folds the navigation behind a toggle.
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  // ...and opens on today, a week short of the fixture's Monday.
  await revealAppointmentOnCalendar(page, appointment.id);
  await page.locator(`[data-appointment-id="${appointment.id}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
  const photos = detail(page).getByTestId("appointment-photos");
  await expect(photos.locator(".photo-pet summary")).toContainText("Charlie");
  const chooser = page.waitForEvent("filechooser");
  await photos.locator('.photo-add[data-photo-phase="before"]').click();
  await (await chooser).setFiles({ name: "charlie-before.png", mimeType: "image/png", buffer: decodablePng(640, 480) });
  const tile = photos.locator(".photo-phase", { hasText: "Before" }).locator(".photo-tile");
  await expect(tile).toHaveCount(1);
  return tile;
}

test("@responsive a photo tile opens a full-size preview, and X returns focus to the tile",
  async ({ page, request, tenant }) => {
    const tile = await openWithPhoto(page, request, tenant);
    const open = tile.locator(".photo-open");
    await expect(open).toHaveAttribute("aria-label", "View Before photo of Charlie full size");
    const src = await tile.locator("img").getAttribute("src");
    expect(src).toMatch(/\/api\/appointment-photos\/[0-9a-f-]+\/content$/u);

    await open.click();
    // MODAL, OVER THE SURFACE. The surface is still open behind it.
    await expect(lightbox(page)).toBeVisible();
    await expect(detail(page)).toBeVisible();
    await expect(lightbox(page).getByTestId("photo-lightbox-caption")).toHaveText("Before photo of Charlie");
    const preview = lightbox(page).getByTestId("photo-lightbox-image");
    await expect(preview).toHaveAttribute("src", src!);
    await expect(preview).toHaveAttribute("alt", "charlie-before.png");
    // The same bytes, decoded at full size - not a broken glyph and not the thumbnail's box.
    await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640);
    const shown = await preview.boundingBox();
    const thumb = await tile.boundingBox();
    expect(shown!.width).toBeGreaterThan(thumb!.width * 2);
    // Focus is on the X, so Enter or Escape leaves without a hunt.
    const close = lightbox(page).getByTestId("photo-lightbox-close");
    await expect(close).toBeFocused();
    await expect(close).toHaveAttribute("aria-label", "Close photo");
    // A coarse pointer's only way out is the X: a 36px icon button that a finger can still press
    // across 44 through the shared hit area.
    await expectTouchTarget(close);

    await close.click();
    await expect(lightbox(page)).toBeHidden();
    await expect(detail(page)).toBeVisible();
    await expect(open).toBeFocused();
    // Emptied on close: the dialog holds no photo while shut.
    await expect(lightbox(page).getByTestId("photo-lightbox-image")).toHaveCount(0);
  });

test("Escape closes the preview too, and the keyboard reaches it from the tile",
  async ({ page, request, tenant }) => {
    const tile = await openWithPhoto(page, request, tenant);
    const open = tile.locator(".photo-open");
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(lightbox(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox(page)).toBeHidden();
    // Escape took the preview and not the surface beneath it: one layer at a time.
    await expect(detail(page)).toBeVisible();
    await expect(open).toBeFocused();

    // And Remove is still its own control beside it, untouched by the preview.
    await expect(tile.locator(".photo-remove")).toHaveAttribute("aria-label", "Remove charlie-before.png");
  });
