import {
  test,
  expect,
  login,
  createAppointment,
  createMember,
  prepareReceipt
} from "./fixtures/tenant.js";

test("@regression-crm-history creates a customer and pet and persists their relationship", async ({ page, tenant }) => {
  const token = tenant.runId.slice(-8);
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("new-customer").click();
  await page.getByTestId("field-firstName").fill("D3");
  await page.getByTestId("field-lastName").fill(`Persist ${token}`);
  await page.getByTestId("field-email").fill(`persist-${token}@example.test`);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.locator('[data-action="new-pet"]').click();
  await page.getByTestId("field-customerId").selectOption({ label: `D3 Persist ${token}` });
  await page.getByTestId("field-name").fill(`Pet ${token}`);
  await page.getByTestId("field-breed").fill("Pilot Terrier");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.reload();
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: `D3 Persist ${token}` });
  await expect(card).toContainText(`Pet ${token}`);
});

test("@regression-crm-history protects safety edits and reconciles a stale safety form", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.locator(`[data-pet-id="${tenant.rockyPetId}"]`).getByRole("button", { name: "Safety" }).click();
  await page.getByTestId("field-safetyAlerts").fill("Two handlers required");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  const current = (await (await request.get(`/api/pets?customerId=${tenant.rockyCustomerId}`)).json())
    .find((pet: { id: string }) => pet.id === tenant.rockyPetId);
  await page.locator(`[data-pet-id="${tenant.rockyPetId}"]`).getByRole("button", { name: "Safety" }).click();
  await expect(page.getByTestId("field-safetyAlerts")).toHaveValue("Two handlers required");

  const concurrent = await request.put(`/api/pets/${tenant.rockyPetId}/safety`, {
    data: { version: current.version, safetyAlerts: "Authoritative newer warning" }
  });
  expect(concurrent.status()).toBe(200);
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/pets/${tenant.rockyPetId}/safety`)
      && response.request().method() === "PUT"
  );
  await page.getByTestId("field-safetyAlerts").fill("Stale warning");
  await page.getByTestId("modal-submit").click();
  expect((await staleResponse).status()).toBe(409);
  await expect(page.locator("#modal-error")).toContainText("changed");
  await expect(page.getByTestId("field-safetyAlerts")).toHaveValue("Authoritative newer warning");
});

test("@regression-crm-history keeps search associations coherent and suppresses archived-parent pets", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-search").fill("Sophia Chen");
  const sophia = page.getByTestId("customer-card").filter({ hasText: "Sophia Chen" });
  await expect(sophia).toContainText("Mochi");
  await expect(sophia).toContainText("Boba");

  const filtered = await request.get(`/api/pets?q=Mochi&customerId=${tenant.sophiaCustomerId}`);
  expect(filtered.status()).toBe(200);
  expect((await filtered.json()).map((pet: { id: string }) => pet.id)).toEqual([tenant.mochiPetId]);

  const archived = await request.post(`/api/customers/${tenant.sophiaCustomerId}/archive`);
  expect(archived.status()).toBe(204);
  const activePets = await request.get("/api/pets?q=Mochi");
  expect((await activePets.json()).some((pet: { id: string }) => pet.id === tenant.mochiPetId)).toBe(false);
  await page.getByTestId("customer-search").fill("");
  await expect(page.getByTestId("customer-card").filter({ hasText: "Sophia Chen" })).toHaveCount(0);
});

test("@regression-crm-history shows current names and terminal history while permission-projecting finances", async ({ page, request, browser, tenant }) => {
  await prepareReceipt(request, tenant);
  const cancelled = await createAppointment(request, tenant, {
    startAt: new Date(new Date(tenant.anchor).getTime() + 86_400_000 + 17 * 3_600_000).toISOString()
  });
  expect((await request.post(`/api/appointments/${cancelled.id}/transition`, {
    data: { status: "cancelled", version: cancelled.version }
  })).status()).toBe(200);
  const noShow = await createAppointment(request, tenant, {
    startAt: new Date(new Date(tenant.anchor).getTime() + 2 * 86_400_000 + 17 * 3_600_000).toISOString()
  });
  expect((await request.post(`/api/appointments/${noShow.id}/transition`, {
    data: { status: "no_show", version: noShow.version }
  })).status()).toBe(200);

  const customer = (await (await request.get("/api/customers")).json())
    .find((item: { id: string }) => item.id === tenant.customerId);
  expect((await request.put(`/api/customers/${tenant.customerId}`, {
    data: { ...customer, firstName: "Current", lastName: "Identity" }
  })).status()).toBe(200);
  const pet = (await (await request.get(`/api/pets?customerId=${tenant.customerId}`)).json())
    .find((item: { id: string }) => item.id === tenant.petId);
  expect((await request.put(`/api/pets/${tenant.petId}`, {
    data: {
      customerId: pet.customerId, name: "Current Pet", species: pet.species,
      breed: pet.breed, dateOfBirth: pet.dateOfBirth, approximateAge: pet.approximateAge,
      weightOunces: pet.weightOunces, sex: pet.sex, coatNotes: pet.coatNotes,
      groomingPreferences: pet.groomingPreferences, photoPermission: pet.photoPermission,
      version: pet.version
    }
  })).status()).toBe(200);

  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  const ownerCard = page.getByTestId("customer-card").filter({ hasText: "Current Identity" });
  await ownerCard.getByRole("button", { name: "History" }).click();
  await expect(page.getByTestId("modal")).toContainText("Current Pet");
  await expect(page.getByTestId("modal")).toContainText("completed");
  await expect(page.getByTestId("modal")).toContainText("cancelled");
  await expect(page.getByTestId("modal")).toContainText("no show");
  await expect(page.getByTestId("modal")).toContainText("Invoice");

  const member = await createMember(
    request,
    `history-only-${tenant.runId}@pawsh-test.example`,
    ["customers.view", "pets.view"]
  );
  const restrictedContext = await browser.newContext();
  const restrictedPage = await restrictedContext.newPage();
  await login(restrictedPage, member.email);
  await restrictedPage.getByTestId("nav-customers").click();
  await restrictedPage.getByTestId("customer-card")
    .filter({ hasText: "Current Identity" })
    .getByRole("button", { name: "History" }).click();
  await expect(restrictedPage.getByTestId("modal")).toContainText("Financial history requires payment access");
  await expect(restrictedPage.getByTestId("modal")).not.toContainText("Invoice ");
  await restrictedContext.close();
});
