import { test, expect, login, createAppointment } from "./fixtures/tenant.js";
import { expectEffectiveTarget, expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { Page } from "@playwright/test";

/**
 * THE CALENDAR ON FIVE PHONES.
 *
 * Human QA, second pass: the toolbar was still a stack of full-size boxes, the menus were airy,
 * and the navigation opened as a sideways strip. The decisions held here, at every width a phone
 * is actually sold in - 320, 360, 375, 390 and 430 CSS pixels:
 *
 *   NOTHING OVERFLOWS SIDEWAYS. `expectNoDocumentOverflow` at every width, with every menu open.
 *   COMPACT, BUT STILL A 44px TARGET. Every toolbar control paints at 36px or less and reaches
 *       44px through its hit area - measured by `expectEffectiveTarget`, which asks the page what
 *       a press would land on rather than reading the painted box.
 *   THE NAVIGATION IS A SHEET. The hamburger opens it over the calendar, the destinations stack as
 *       44px rows that scroll normally, the same button - now a cross - closes it, and so do Escape
 *       and the backdrop. The calendar is never squeezed beside it.
 *   MENUS ARE DENSE. Every row of the + New and account menus is 44px tall on a phone and no
 *       taller, separators carry 2px, and the menu's own padding is 4px.
 */

const WIDTHS = [320, 360, 375, 390, 430];

async function openCalendar(page: Page): Promise<void> {
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-calendar").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

test("@responsive the calendar is compact, target-safe and never overflows at five phone widths",
  async ({ page, request, tenant }, testInfo) => {
    test.setTimeout(120_000);
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 780 });
      await openCalendar(page);
      await expectNoDocumentOverflow(page, testInfo);

      // The bar above the page holds one button and is sized for it, not for a desktop rail.
      const aside = await page.locator("#app-view > aside").boundingBox();
      expect(aside!.height, `${width}: the top bar is one compact row`).toBeLessThanOrEqual(60);
      // Every header control is on the screen - the account button used to be cut off at 320.
      for (const testid of ["header-services", "new-action-trigger", "intake-submissions", "account-trigger"]) {
        const box = await page.getByTestId(testid).boundingBox();
        expect(box!.x + box!.width, `${width}: ${testid} is on screen`).toBeLessThanOrEqual(width);
      }

      // The toolbar: three compact rows, every control a full effective target.
      const toolbar = await page.locator(".calendar-toolbar").boundingBox();
      expect(toolbar!.height, `${width}: three compact rows`).toBeLessThan(130);
      for (const selector of ["#calendar-today", "#calendar-prev-week", "#calendar-next-week", "#calendar-view-select",
        "#groomer-filter-trigger", "[data-testid=print-agenda]", "[data-testid=calendar-settings]",
        "#calendar-agenda-mode", "#calendar-calendar-mode"]) {
        await expectEffectiveTarget(page.locator(selector));
      }
      for (const selector of ["#calendar-today", "#calendar-prev-week", "#groomer-filter-trigger",
        "[data-testid=print-agenda]", "#calendar-agenda-mode"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box!.height, `${width}: ${selector} paints at 36px`).toBeLessThanOrEqual(38);
      }
      // The view select is the one control that keeps a 44px box: it paints its field 36px tall
      // inside transparent borders, so its painted line is the inset shadow, not the border.
      const select = await page.locator("#calendar-view-select").evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: style.borderTopColor, clip: style.backgroundClip, height: element.getBoundingClientRect().height };
      });
      expect(select.height).toBeGreaterThanOrEqual(44);
      expect(select.top).toBe("rgba(0, 0, 0, 0)");
      expect(select.clip).toBe("padding-box");

      // The groomer filter opens as a full-width popover under its trigger and stays on screen.
      await page.locator("#groomer-filter-trigger").click();
      const popover = page.locator(".groomer-filter-popover");
      await expect(popover).toBeVisible();
      const popoverBox = await popover.boundingBox();
      expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
      expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(width + 1);
      expect(popoverBox!.height, `${width}: one groomer does not need 160px of popover`).toBeLessThan(150);
      await expectEffectiveTarget(page.locator("#groomer-filter-options label").first());
      await expectNoDocumentOverflow(page, testInfo);
      await page.keyboard.press("Escape");
      if (await page.locator("#groomer-filter").getAttribute("open") !== null) await page.locator("#groomer-filter-trigger").click();
    }
  });

test("@responsive the + New and account menus are dense rows, anchored under their triggers",
  async ({ page, request, tenant }, testInfo) => {
    test.setTimeout(120_000);
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 780 });
      await openCalendar(page);

      await page.getByTestId("new-action-trigger").click();
      const menu = page.getByTestId("new-action-menu");
      await expect(menu).toBeVisible();
      const trigger = await page.getByTestId("new-action-trigger").boundingBox();
      const menuBox = await menu.boundingBox();
      expect(menuBox!.y, `${width}: the menu opens under + New, not over the header`).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width + 1);
      const rows = menu.getByRole("menuitem");
      for (let index = 0; index < await rows.count(); index += 1) {
        const box = await rows.nth(index).boundingBox();
        expect(box!.height, `${width}: + New row ${index} is one 44px row`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${width}: + New row ${index} is not taller than a row`).toBeLessThanOrEqual(48);
      }
      const separators = await menu.locator("hr").evaluateAll((elements) =>
        elements.map((element) => parseFloat(getComputedStyle(element).marginTop) + parseFloat(getComputedStyle(element).marginBottom)));
      for (const gap of separators) expect(gap, `${width}: a separator carries no more than 4px`).toBeLessThanOrEqual(4);
      expect(menuBox!.height, `${width}: eight rows and three rules fit in under 380px`).toBeLessThan(380);
      await expectNoDocumentOverflow(page, testInfo);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      await page.getByTestId("account-trigger").click();
      const account = page.locator("#account-menu");
      await expect(account).toBeVisible();
      const accountTrigger = await page.getByTestId("account-trigger").boundingBox();
      const accountBox = await account.boundingBox();
      expect(accountBox!.y, `${width}: the account menu opens under its trigger`).toBeGreaterThanOrEqual(accountTrigger!.y + accountTrigger!.height);
      expect(accountBox!.x).toBeGreaterThanOrEqual(0);
      expect(accountBox!.x + accountBox!.width).toBeLessThanOrEqual(width + 1);
      const accountRows = account.getByRole("menuitem");
      for (let index = 0; index < await accountRows.count(); index += 1) {
        const box = await accountRows.nth(index).boundingBox();
        expect(box!.height, `${width}: account row ${index}`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${width}: account row ${index}`).toBeLessThanOrEqual(48);
      }
      await expectNoDocumentOverflow(page, testInfo);
      await page.keyboard.press("Escape");
      await expect(account).toBeHidden();
    }
  });

test("@responsive the navigation opens as a sheet over the calendar and closes three ways",
  async ({ page, request, tenant }, testInfo) => {
    test.setTimeout(120_000);
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await login(page, tenant.ownerEmail);
    for (const width of WIDTHS) {
      // Short, so nine destinations plus a divider have to scroll inside the sheet.
      await page.setViewportSize({ width, height: 480 });
      await openCalendar(page);
      const toggle = page.locator("#mobile-nav-toggle");
      const nav = page.locator("#primary-navigation");
      await expect(toggle).toBeVisible();
      await expect(nav).toBeHidden();
      const calendarBefore = await page.locator("#calendar-list").boundingBox();

      // OPEN. The sheet sits over the page from the left edge; the calendar underneath keeps its
      // width - nothing is squeezed beside the sheet.
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAccessibleName("Close navigation");
      await expect(nav).toBeVisible();
      const sheet = await nav.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return { position: style.position, direction: style.flexDirection, overflowY: style.overflowY,
          x: box.x, width: box.width, height: box.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      });
      expect(sheet.position).toBe("fixed");
      expect(sheet.direction).toBe("column");
      expect(sheet.x).toBe(0);
      expect(sheet.width).toBeGreaterThanOrEqual(Math.min(300, width * 0.86) - 1);
      expect(sheet.width).toBeLessThan(width);
      expect(sheet.height).toBe(480);
      // It scrolls normally inside: the list is taller than the short screen.
      expect(sheet.overflowY).toBe("auto");
      expect(sheet.scrollHeight).toBeGreaterThan(sheet.clientHeight);
      await nav.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByTestId("nav-setup")).toBeInViewport();
      const calendarOpen = await page.locator("#calendar-list").boundingBox();
      expect(calendarOpen!.width, `${width}: the calendar is not squeezed`).toBe(calendarBefore!.width);
      // Every destination is a full-width 44px row.
      for (const testid of ["nav-dashboard", "nav-calendar", "nav-customers", "nav-setup"]) {
        const box = await page.getByTestId(testid).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThan(sheet.width * 0.8);
      }
      await expectNoDocumentOverflow(page, testInfo);

      // CLOSE, three ways: the cross, Escape, and the backdrop.
      await toggle.click();
      await expect(nav).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveAccessibleName("Open navigation");

      await toggle.click();
      await expect(nav).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(nav).toBeHidden();
      await expect(toggle).toBeFocused();

      await toggle.click();
      await expect(nav).toBeVisible();
      await page.mouse.click(width - 10, 300);
      await expect(nav).toBeHidden();

      // And choosing a destination closes it as it always did.
      await toggle.click();
      await page.getByTestId("nav-customers").click();
      await expect(nav).toBeHidden();
      await expect(page.getByTestId("customers-view")).toBeVisible();
    }
  });
