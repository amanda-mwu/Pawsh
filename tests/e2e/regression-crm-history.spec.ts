import {
  test,
  expect,
  login,
  createAppointment,
  createMember,
  prepareReceipt
} from "./fixtures/tenant.js";
import { cardForPet, petAction } from "./helpers/clients.js";

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
  await page.getByTestId("field-breed").fill("gold");
  await expect(page.getByRole("option", { name: "Golden Retriever" })).toBeVisible();
  await page.getByTestId("field-breed").press("Enter");
  await expect(page.getByTestId("field-breed")).toHaveValue("Golden Retriever");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  await page.reload();
  await page.getByTestId("nav-customers").click();
  const card = page.getByTestId("customer-card").filter({ hasText: `D3 Persist ${token}` });
  await expect(card).toContainText(`Pet ${token}`);
  await petAction(card, "profile");
  await expect(page.getByTestId("field-breed")).toHaveValue("Golden Retriever");
  await page.getByTestId("field-breed").fill("Historic Village Dog");
  await page.getByTestId("field-breed").press("Escape");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await petAction(card, "profile");
  await expect(page.getByTestId("field-breed")).toHaveValue("Historic Village Dog");
});

test("@regression-crm-history protects Pet Care edits and reconciles a stale care form", async ({ page, request, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await petAction(cardForPet(page, tenant.rockyPetId), "care", tenant.rockyPetId);
  await page.getByTestId("field-safetyAlerts").fill("Two handlers required");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  const current = (await (await request.get(`/api/pets?customerId=${tenant.rockyCustomerId}`)).json())
    .find((pet: { id: string }) => pet.id === tenant.rockyPetId);
  await petAction(cardForPet(page, tenant.rockyPetId), "care", tenant.rockyPetId);
  await expect(page.getByTestId("field-safetyAlerts")).toHaveValue("Two handlers required");

  const concurrent = await request.put(`/api/pets/${tenant.rockyPetId}/care`, {
    data: { version: current.version, safetyAlerts: "Authoritative newer warning" }
  });
  expect(concurrent.status()).toBe(200);
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/pets/${tenant.rockyPetId}/care`)
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
  await ownerCard.getByTestId("client-row-actions").click();
  await ownerCard.getByTestId("client-appointment-history").click();
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
  const restrictedCard = restrictedPage.getByTestId("customer-card")
    .filter({ hasText: "Current Identity" });
  await restrictedCard.getByTestId("client-row-actions").click();
  await restrictedCard.getByTestId("client-appointment-history").click();
  await expect(restrictedPage.getByTestId("modal")).toContainText("Financial history requires payment access");
  await expect(restrictedPage.getByTestId("modal")).not.toContainText("Invoice ");
  await restrictedContext.close();
});

// The profile leads with figures that reconcile, then splits appointments into what is ahead
// and what is settled. History opens at two rows and grows rather than running the page long.
test("@regression-crm-history summarises sales and pages client history in small steps", async ({ page, request, tenant }) => {
  const { invoice } = await prepareReceipt(request, tenant);
  expect(invoice.id).toBeTruthy();
  // Full Groom runs 90 minutes and the receipt already holds 09:00, so the rest are spaced to
  // avoid overlap and spill onto the following day. Each is completed, because "history" means
  // settled work: a future booking would land in Upcoming instead.
  const nextDay = new Date(`${tenant.anchor}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const slots = [
    `${tenant.anchor}T11:00`, `${tenant.anchor}T12:30`, `${tenant.anchor}T14:00`, `${tenant.anchor}T15:30`,
    `${nextDay.toISOString().slice(0,10)}T09:00`, `${nextDay.toISOString().slice(0,10)}T10:30`,
    `${nextDay.toISOString().slice(0,10)}T12:00`
  ];
  for (const localStart of slots) {
    const appointment = await createAppointment(request, tenant, { localStart });
    let version = appointment.version;
    for (const status of ["checked_in", "in_service", "completed"]) {
      const moved = await request.post(`/api/appointments/${appointment.id}/transition`, { data: { status, version } });
      expect(moved.status(), `${localStart} ${status}`).toBe(200);
      version = (await moved.json()).version;
    }
  }
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" })
    .getByRole("button", { name: "Emma Johnson" }).click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();

  // Total is what was invoiced; outstanding is what is still owed on it. Paid + outstanding
  // reconciling against total is the whole point of showing both.
  const summary = page.getByTestId("client-summary");
  await expect(summary).toBeVisible();
  await expect(page.getByTestId("summary-total")).not.toHaveText("$0.00");
  await expect(page.getByTestId("summary-outstanding")).toHaveText("$0.00");
  await expect(summary).toContainText("Completed");
  // Pawsh sells no retail, so no retail figure is invented.
  await expect(summary).not.toContainText("Retail");

  const historyRows = page.locator(".history-table").last().locator("tbody tr");
  await expect(historyRows).toHaveCount(2);
  await expect(page.getByTestId("history-page")).toContainText("Page 1 of");

  await page.getByRole("button", { name: /^Load \d+ more$/ }).click();
  await expect(historyRows).toHaveCount(5);

  // The arrows move through pages of whatever size history has grown to.
  await page.getByRole("button", { name: "Older appointments" }).click();
  await expect(page.getByTestId("history-page")).toContainText("Page 2 of");
  await expect(historyRows).not.toHaveCount(0);
  await page.getByRole("button", { name: "Newer appointments" }).click();
  await expect(page.getByTestId("history-page")).toContainText("Page 1 of");
  await expect(page.getByRole("button", { name: "Newer appointments" })).toBeDisabled();
});

// Somebody rings to ask about a groom, gives a number and the breed, and hangs up before
// booking. That call has to be writable down, and findable afterwards.
test("@regression-crm-history records a phone enquiry with no name and fills it in later", async ({ page, tenant }) => {
  const phone = `(704) 957-${tenant.runId.slice(-4).replace(/\D/g, "0").padStart(4, "0")}`;
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("new-customer").click();
  // Nothing but the phone number: no name is typed at all.
  await page.getByTestId("field-phone").fill(phone);
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  const card = page.getByTestId("customer-card").filter({ hasText: phone });
  await expect(card).toHaveCount(1);
  // Unknown reads as "Not set" rather than a blank cell or a literal placeholder name.
  await expect(card.getByRole("button", { name: "Not set" })).toBeVisible();

  // A pet whose breed is known but whose name was never given.
  await page.getByRole("button", { name: /\+ Pet/ }).click();
  await page.getByTestId("field-customerId").selectOption({ label: "Not set" });
  await page.getByTestId("field-breed").fill("Goldendoodle");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(card).toContainText("Goldendoodle");

  // The record is findable by the one detail it has.
  await page.getByTestId("customer-search").fill(phone.replace(/\D/g, ""));
  await expect(page.getByTestId("customer-card")).toHaveCount(1);

  // And it becomes a full record when they call back, without a second row appearing.
  await page.getByTestId("customer-card").getByRole("button", { name: "Not set" }).click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByTestId("field-firstName").fill("Aaron");
  await page.getByTestId("field-lastName").fill("Cayabyab");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByRole("heading", { name: "Aaron Cayabyab" })).toBeVisible();
});
