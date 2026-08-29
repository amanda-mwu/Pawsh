import { expect, login, test } from "./fixtures/tenant.js";
test("@regression-crm-history business breeds can be added, renamed and deleted", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.goto("/settings/pet-options");
  await page.locator("#pet-type-body tr[data-pet-type-row]").nth(0).getByRole("button", { name: "Breeds" }).click();
  await expect(page.getByTestId("breed-drawer")).toBeVisible();
  // Shared breeds carry no rename/delete affordance.
  const shared = page.locator('#breed-drawer-list li:not([data-business-owned])').first();
  await expect(shared.locator(".breed-rename")).toHaveCount(0);
  // Add
  await page.locator("#breed-add").click();
  await page.getByTestId("breed-name-input").fill("Cavapoochon");
  await page.getByTestId("modal-submit").click();
  const own = page.locator('#breed-drawer-list li[data-business-owned="true"]');
  await expect(own).toHaveCount(1);
  await expect(own).toContainText("Cavapoochon");
  // Rename
  await own.locator(".breed-rename").click();
  await page.getByTestId("breed-name-input").fill("Cavapoochon Deluxe");
  await page.getByTestId("modal-submit").click();
  await expect(page.locator('#breed-drawer-list li[data-business-owned="true"]')).toContainText("Cavapoochon Deluxe");
  // Delete
  await page.locator('#breed-drawer-list li[data-business-owned="true"] .breed-delete').click();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.locator('#breed-drawer-list li[data-business-owned="true"]')).toHaveCount(0);
});
