import { resolve } from "node:path";
import { test, expect, login, createMember } from "./fixtures/tenant.js";

const fixture = resolve("tests/fixtures/rabies-vaccination.pdf");

test("@regression-pet-documents uploads, downloads, and replaces a rabies record", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await card.getByRole("button", { name: "Documents" }).click();
  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await page.locator('input[name="expiration"]').fill("2036-08-17");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await card.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByTestId("rabies-current")).toContainText("rabies-vaccination.pdf");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rabies-vaccination.pdf");

  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await page.locator('input[name="expiration"]').fill("2037-08-17");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await card.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByText("Previous records")).toBeVisible();
});

test("@regression-pet-documents enforces Pet Care document permissions", async ({ page, request, tenant }) => {
  const member = await createMember(request, `documents-view-${tenant.runId}@pawsh-test.example`, [
    "customers.view", "pets.view", "pets.care.view"
  ]);
  await login(page, member.email);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await card.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByTestId("field-rabiesPdf")).toHaveCount(0);

  const revoked = await request.patch(`/api/members/${member.membershipId}/permissions`, {
    data: { permissions: ["customers.view", "pets.view"] }
  });
  expect(revoked.ok()).toBeTruthy();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await page.getByTestId("nav-customers").click();
  await expect(card.getByRole("button", { name: "Documents" })).toHaveCount(0);
});

test("@regression-pet-documents keeps archived Pet Care evidence reachable outside active search", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await card.getByRole("button", { name: "Documents" }).click();
  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  const archived = await request.post(`/api/customers/${tenant.customerId}/archive`);
  expect(archived.status()).toBe(204);
  await page.reload();
  await page.getByTestId("nav-customers").click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Archived records" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Documents" }).click();
  await expect(page.getByTestId("rabies-current")).toContainText("rabies-vaccination.pdf");
  await expect(page.getByTestId("field-rabiesPdf")).toHaveCount(0);
});
