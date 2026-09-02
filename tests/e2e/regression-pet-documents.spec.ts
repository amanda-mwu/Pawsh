import { resolve } from "node:path";
import { test, expect, login, createMember, setMemberPermissions } from "./fixtures/tenant.js";
import { petAction, petActionSelector } from "./helpers/clients.js";

const fixture = resolve("tests/fixtures/rabies-vaccination.pdf");

test("@regression-pet-documents uploads, downloads, and replaces a rabies record", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await petAction(card, "care");
  await page.getByTestId("field-vaccinationExpiresOn").fill("2036-08-17");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await petAction(card, "documents");
  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await expect(page.locator('input[name="expiration"]')).toHaveCount(0);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await petAction(card, "documents");
  await expect(page.getByTestId("rabies-current")).toContainText("rabies-vaccination.pdf");
  await expect(page.getByTestId("rabies-current")).toContainText("8/17/2036");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rabies-vaccination.pdf");

  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await petAction(card, "documents");
  await expect(page.getByTestId("rabies-current")).toContainText("8/17/2036");
  await expect(page.getByText("Previous records")).toBeVisible();
});

test("@regression-pet-documents enforces Pet Care document permissions", async ({ page, request, tenant }) => {
  const member = await createMember(request, `documents-view-${tenant.runId}@pawsh-test.example`, [
    "customers.view", "pets.view", "pets.care.view"
  ]);
  await login(page, member.email);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await petAction(card, "documents");
  // showPetDocuments() awaits GET /api/pets/:id/documents before opening the modal, so the
  // absence assertion below resolves instantly against a dialog that does not exist yet and
  // the revoke lands mid-request. Wait for the dialog first: the assertion then means "the
  // upload field is absent from an open Pet Care modal" rather than "nothing has rendered".
  await expect(page.getByTestId("modal")).toBeVisible();
  await expect(page.getByTestId("field-rabiesPdf")).toHaveCount(0);

  // A member's access is their role now, so revoking Pet Care edits the role they hold. The
  // per-member permission column this used to write was retired with migration 0042.
  await setMemberPermissions(request, member.roleId, ["customers.view", "pets.view"]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await page.getByTestId("nav-customers").click();
  await expect(card.locator(petActionSelector("documents"))).toHaveCount(0);
});

test("@regression-pet-documents keeps archived Pet Care evidence reachable outside active search", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: "Charlie" });
  await petAction(card, "documents");
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
