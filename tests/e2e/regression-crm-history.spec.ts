import {
  test,
  expect,
  login,
  createAppointment,
  createMember,
  prepareReceipt
} from "./fixtures/tenant.js";
import { cardForPet, petAction } from "./helpers/clients.js";
import { decodablePng } from "../support/images.js";

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
  // Editing a client is its own panel now, alongside their addresses and contacts.
  await page.getByRole("button", { name: "Edit" }).first().click();
  const editor = page.getByTestId("client-edit-dialog");
  await expect(editor).toBeVisible();
  await editor.getByTestId("field-firstName").fill("Aaron");
  await editor.getByTestId("field-lastName").fill("Cayabyab");
  await editor.getByTestId("client-basic-save").click();
  // Wait for the save to land before closing: the panel retitles itself from the reloaded record.
  await expect(page.locator("#client-edit-title")).toHaveText("Aaron Cayabyab · Edit client");
  await editor.getByRole("button", { name: "Close client editor" }).click();
  await expect(page.getByRole("heading", { name: "Aaron Cayabyab" })).toBeVisible();
});

// The pet profile is one panel with independently-saving sections. Each records something the
// salon actually keeps, and each is honest about what it does not know.
test("@regression-crm-history pet profile keeps identity, notes, photos, medical, and vaccinations", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" })
    .getByRole("button", { name: "Emma Johnson" }).click();
  await page.locator(`[data-pet-profile="${tenant.petId}"]`).click();
  const panel = page.getByTestId("pet-profile-dialog");
  await expect(panel).toBeVisible();

  // Every dropdown opens blank when nothing was recorded, so an unanswered question never
  // renders as though somebody answered it.
  await expect(panel.getByTestId("field-fixedStatus")).toHaveValue("");
  await expect(panel.getByTestId("field-hairLength")).toHaveValue("");
  // Spayed and neutered carry the sex too, which a plain yes/no would lose.
  await panel.getByTestId("field-fixedStatus").selectOption("neutered");
  await panel.getByTestId("field-hairLength").selectOption("Cat Long Hair");
  await panel.getByTestId("field-species").selectOption("Cat");
  await panel.getByTestId("field-sex").selectOption("Male");
  await panel.getByTestId("field-approximateAgeMonths").selectOption("4");
  await panel.getByTestId("field-mixedBreed").check();
  await panel.getByTestId("field-coatColor").fill("Parti");
  await panel.getByTestId("field-preferredShampoo").fill("Oatmeal");
  await panel.getByTestId("pet-identity-save").click();
  await expect(panel.getByTestId("field-fixedStatus")).toHaveValue("neutered");
  await expect(panel.getByTestId("field-species")).toHaveValue("Cat");
  await expect(panel.getByTestId("field-approximateAgeMonths")).toHaveValue("4");
  await expect(panel.getByTestId("field-mixedBreed")).toBeChecked();
  await expect(panel.getByTestId("field-preferredShampoo")).toHaveValue("Oatmeal");
  // A colour becomes a suggestion for the next pet the moment somebody types it.
  await expect(panel.locator("#pet-coat-colors option[value=\"Parti\"]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close pet profile" }).click();
  await page.locator(`[data-pet-profile="${tenant.petId}"]`).click();
  await expect(panel.locator("#pet-coat-colors option[value=\"Parti\"]")).toHaveCount(1);

  // Notes carry their author and time.
  await panel.getByTestId("pet-note-add").click();
  await page.locator('#stacked-dialog [name="body"]').fill("One inch reverse, round head.");
  await page.getByTestId("stacked-dialog-confirm").click();
  const notes = panel.getByTestId("pet-notes");
  await expect(notes).toContainText("One inch reverse, round head.");
  await expect(notes.locator("li").first().locator("small")).toContainText("by ");

  // Medical: not asked and nothing-to-report are different facts, and the panel says which.
  await expect(panel).toContainText("Not asked yet.");
  await panel.getByTestId("pet-medical-save").click();
  await expect(panel).toContainText("Recorded as nothing to report.");
  // Rabies is not offered as a tick box; it is recorded where it decides bookability.
  await expect(panel.locator(".pet-health-issues")).not.toContainText("Rabies");
  await expect(panel).toContainText("Rabies is not listed here");

  // Photos, with the first upload becoming the profile picture.
  const chooser = page.waitForEvent("filechooser");
  await panel.getByTestId("pet-photo-add").click();
  await (await chooser).setFiles({
    name: "charlie.png", mimeType: "image/png", buffer: decodablePng(300, 300)
  });
  const tile = panel.getByTestId("pet-photos").locator(".photo-tile");
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveClass(/is-avatar/);
  await expect(panel.locator(".pet-identity-head img")).toBeVisible();

  // Vaccinations: rabies is listed but edited where it lives; others are ordinary records.
  const vaccinations = panel.getByTestId("pet-vaccinations");
  await expect(vaccinations.getByTestId("pet-vaccination-rabies")).toContainText("Rabies");

  // One dialog for every vaccine, opening on Rabies because that is the one that decides
  // whether an appointment can go ahead.
  await panel.getByTestId("pet-vaccination-add").click();
  await expect(page.locator('#stacked-dialog [name="vaccine"]')).toHaveValue("Rabies");
  await page.locator('#stacked-dialog [name="expiresOn"]').fill("2031-03-02");
  await page.locator('#stacked-dialog [name="document"]').setInputFiles({
    name: "rabies.pdf", mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n")
  });
  await page.getByTestId("stacked-dialog-confirm").click();
  // Rabies lands on the care record rather than becoming a free row, so the table still has
  // exactly one rabies line and it now carries the certificate.
  await expect(vaccinations.getByTestId("pet-vaccination-rabies")).toContainText("View document");
  await expect(vaccinations.locator("tbody tr")).toHaveCount(1);

  // Anything else is an ordinary record with its own attachment.
  await panel.getByTestId("pet-vaccination-add").click();
  await page.locator('#stacked-dialog [name="vaccine"]').selectOption("Bordetella");
  await page.locator('#stacked-dialog [name="expiresOn"]').fill("2030-04-01");
  await page.locator('#stacked-dialog [name="document"]').setInputFiles({
    name: "bordetella.png", mimeType: "image/png", buffer: decodablePng(200, 200)
  });
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(vaccinations).toContainText("Bordetella");
  await expect(vaccinations.locator("tbody tr")).toHaveCount(2);
  await expect(vaccinations.locator("tbody tr").nth(1).getByRole("link", { name: "View document" }))
    .toBeVisible();

  // Both fields are required: a vaccine with no expiry cannot answer the only question anybody
  // asks of it.
  await panel.getByTestId("pet-vaccination-add").click();
  await page.locator('#stacked-dialog [name="vaccine"]').selectOption("Lyme");
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeVisible();
  await page.getByTestId("stacked-dialog-dismiss").click();

  // Vet info saves on its own.
  await panel.getByTestId("field-vetName").fill("Bayview Animal Hospital");
  await panel.getByTestId("pet-vet-save").click();
  await expect(panel.getByTestId("field-vetName")).toHaveValue("Bayview Animal Hospital");

  // Named so the idea is on the record, and honest that it does nothing.
  await expect(panel.getByTestId("pet-pricing")).toContainText("Customized price and duration");
  await expect(panel.getByTestId("pet-pricing")).toContainText("Not available");
  await expect(panel.getByTestId("pet-pricing").locator("input")).toHaveCount(0);
});

// A client is rarely one address and one phone number: the house and the second home, the owner
// and the dog walker who actually does the pick-up.
test("@regression-crm-history client editor keeps several addresses and contacts with one primary", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("nav-customers").click();
  await page.getByTestId("customer-card").filter({ hasText: "Emma Johnson" })
    .getByRole("button", { name: "Emma Johnson" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  const panel = page.getByTestId("client-edit-dialog");
  await expect(panel).toBeVisible();

  const addAddress = async (address: string) => {
    await panel.getByTestId("client-address-add").click();
    await page.locator('#stacked-dialog [name="address"]').fill(address);
    await page.getByTestId("stacked-dialog-confirm").click();
  };
  await addAddress("12 Chestnut Street, Philadelphia, PA");
  const addresses = panel.getByTestId("client-addresses");
  // The first one is primary without anybody saying so.
  await expect(addresses.locator('input[name="primaryAddress"]:checked')).toHaveCount(1);
  await addAddress("88 Shore Road, Margate, NJ");
  await expect(addresses.locator("tbody tr")).toHaveCount(2);
  await expect(addresses.locator('input[name="primaryAddress"]:checked')).toHaveCount(1);

  // Promoting the second demotes the first; there is never more than one answer to
  // "where do we go?".
  await addresses.locator("tbody tr").nth(1).locator('input[name="primaryAddress"]').check();
  await expect(addresses.locator('input[name="primaryAddress"]:checked')).toHaveCount(1);
  await expect(addresses.locator("tbody tr").first()).toContainText("88 Shore Road");

  await panel.getByTestId("client-contact-add").click();
  await page.locator('#stacked-dialog [name="name"]').fill("Dana Reeve");
  await page.locator('#stacked-dialog [name="phone"]').fill("(267) 555-0142");
  await page.locator('#stacked-dialog [name="title"]').fill("Dog walker");
  await page.getByTestId("stacked-dialog-confirm").click();
  const contacts = panel.getByTestId("client-contacts");
  await expect(contacts).toContainText("Dana Reeve");
  await expect(contacts).toContainText("Dog walker");
  await expect(panel).toContainText("Contacts (1)");

  // The flag is stored and plainly labelled as driving nothing.
  await expect(panel).toContainText("recorded but not acted on");

  page.once("dialog", (dialog) => dialog.accept());
  await contacts.locator("tbody tr").first().getByRole("button", { name: "Delete" }).click();
  await expect(panel).toContainText("No contacts on file.");
});
