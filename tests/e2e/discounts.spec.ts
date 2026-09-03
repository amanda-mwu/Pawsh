import {
  test, expect, login, createMember, password, completeAppointment, appointmentAction
} from "./fixtures/tenant.js";
import { expectNoDocumentOverflow } from "./helpers/responsive.js";
import { openAdjustment, chooseMethod } from "./helpers/checkout.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Settings → Coupons & discounts.
 *
 * These run against the REAL discount API, with no `page.route` anywhere in the file. The screen's
 * job is to write a discount, a coupon and a stacking rule correctly, so every write is read back
 * through `GET /api/settings/discounts` rather than asserted against a mock's expectations.
 *
 * The route family is gated on `settings.discounts` ALONE — the read included — so a member without
 * it gets a 403 on the read rather than an empty screen, and that is the only permission state the
 * screen can distinguish today.
 *
 * What is worth covering is what is easy to get quietly wrong:
 *   - the value field's constraints not following the mode, so 150% saves as 150%;
 *   - a typed value being clamped on the switch instead of refused, which edits a number the
 *     operator typed without saying so;
 *   - a limitation switched off still reaching the payload, because the fields were hidden rather
 *     than put in a disabled fieldset;
 *   - a limitation switched off CLEARING what was typed, so looking at the total costs the dates;
 *   - `COUPON_CODE_RETIRED` reported as "already exists", which sends the operator hunting a row
 *     that is not on the screen and never will be;
 *   - the stacking tab showing only the selected outcome, which confirms a choice instead of
 *     helping somebody make one;
 *   - a generated code containing I, L, O, 0 or 1, which is the whole failure mode of a code a
 *     client reads off a card.
 */

interface DiscountSettings {
  stackingMode: string;
  discounts: Array<{
    id: string; name: string; kind: string; amountMinor: number|null;
    rateBasisPoints: number|null; applyScope: string; active: boolean;
  }>;
  coupons: Array<{
    id: string; code: string; name: string|null; kind: string; amountMinor: number|null;
    rateBasisPoints: number|null; startsOn: string|null; endsOn: string|null;
    weekdays: number[]|null; newClientsOnly: boolean; maxRedemptions: number|null;
    maxRedemptionsPerClient: number|null; redeemedCount: number; active: boolean;
  }>;
  perPetMultiplier: { supported: boolean; petCountPerAppointment: number; reason: string };
}

async function readSettings(api: APIRequestContext): Promise<DiscountSettings> {
  const response = await api.get("/api/settings/discounts");
  expect(response.ok(),await response.text()).toBeTruthy();
  return await response.json() as DiscountSettings;
}

async function openDiscounts(page: Page): Promise<void> {
  // The rail collapses behind a toggle on a phone, so reach for it the way a person would.
  if(await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-settings").isHidden()){
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation")
    .getByRole("button",{ name:"Coupons & discounts", exact:true }).click();
  await expect(page.getByTestId("discounts-tabs")).toBeVisible();
}

async function openCouponsTab(page: Page): Promise<void> {
  await page.getByTestId("discounts-tab-coupon").click();
  await expect(page.getByTestId("discounts-tab-coupon")).toHaveAttribute("aria-selected","true");
}

test("@smoke the workspace replaces the placeholder and opens on Discounts",async({ page,tenant })=>{
  await login(page,tenant.ownerEmail);
  await openDiscounts(page);

  // The category was a "Coming soon" placeholder until this screen existed. If that article is
  // still rendering, the shell never took the new branch.
  await expect(page.getByTestId("settings-placeholder")).toHaveCount(0);

  // Plural, because each tab is a collection. Singular reads as a form label.
  await expect(page.getByTestId("discounts-tab-discount")).toHaveText("Discounts");
  await expect(page.getByTestId("discounts-tab-coupon")).toHaveText("Coupons");
  await expect(page.getByTestId("discounts-tab-stacking")).toHaveText("Multiple coupons & discounts");

  // The empty state carries the only statement in the product of what separates the two.
  const empty=page.getByTestId("discount-empty");
  await expect(empty).toContainText("A discount is a standing reduction staff can apply at checkout");
  await expect(page.getByTestId("discount-add")).toBeVisible();

  await openCouponsTab(page);
  await expect(page.getByTestId("coupon-empty"))
    .toContainText("Unlike a discount it can expire, run out, or be restricted to new clients");
});

test("@smoke a discount is created through the dialog and stored",async({ page,request,tenant })=>{
  await login(page,tenant.ownerEmail);
  await openDiscounts(page);

  await page.getByTestId("discount-add").click();
  // The reference's own placeholder, spelled correctly.
  await expect(page.getByTestId("field-name")).toHaveAttribute("placeholder","Old Friend Discount");
  await page.getByTestId("field-name").fill("Old Friend Discount");
  await page.getByTestId("field-value").fill("10.00");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  const row=page.locator('[data-discount-row][data-discount-name="Old Friend Discount"]');
  await expect(row).toContainText("$10.00");
  // The apply scope reads back under the amount, because for an amount it is a real statement.
  await expect(row).toContainText("Per appointment");
  await expect(row.getByTestId("discount-enabled")).toBeChecked();

  const stored=await readSettings(request);
  const created=stored.discounts.find((discount)=>discount.name==="Old Friend Discount")!;
  expect(created.kind).toBe("amount");
  expect(created.amountMinor).toBe(1000);
  // Exactly one of the two is sent. The schema refuses both rather than silently picking one.
  expect(created.rateBasisPoints).toBeNull();
});

test("the value field's unit, label and ceiling move with the mode, and 150% is refused rather than clamped",
  async({ page,request,tenant })=>{
    await login(page,tenant.ownerEmail);
    await openDiscounts(page);

    await page.getByTestId("discount-add").click();
    const value=page.getByTestId("field-value");
    const controls=page.locator("[data-discount-controls]");

    // Amount: the salon's own currency symbol, no ceiling.
    await expect(controls.locator("[data-discount-value-label]")).toHaveText("Amount");
    await expect(controls.locator("[data-discount-value-unit]")).toHaveText("$");
    await expect(value).not.toHaveAttribute("max",/.*/);

    await value.fill("150");
    await page.getByTestId("discount-mode-percentage").check();

    // The typed value SURVIVES the switch - it is not silently rewritten to 100 - and the field
    // becomes invalid instead, which is a question rather than an edit.
    await expect(value).toHaveValue("150");
    await expect(controls.locator("[data-discount-value-label]")).toHaveText("Percentage");
    await expect(controls.locator("[data-discount-value-unit]")).toHaveText("%");
    await expect(value).toHaveAttribute("max","100");
    expect(await value.evaluate((input)=>(input as HTMLInputElement).checkValidity())).toBe(false);

    // The hint is live and says what a 100% discount actually does.
    await value.fill("100");
    await expect(controls.locator("[data-discount-hint]")).toHaveText("This makes the appointment free.");
    await value.fill("15");
    await expect(controls.locator("[data-discount-hint]"))
      .toHaveText("Comes off the appointment's subtotal, before tax.");

    // Per Pet ships, and the screen states what it is worth today in the server's own words.
    const settings=await readSettings(request);
    expect(settings.perPetMultiplier.supported).toBe(false);
    await expect(page.getByTestId("discount-per-pet-note")).toHaveText(settings.perPetMultiplier.reason);
    await expect(page.getByTestId("discount-per-pet-note")).not.toContainText("coming soon");

    await page.getByTestId("field-name").fill("Loyalty");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    const stored=await readSettings(request);
    const created=stored.discounts.find((discount)=>discount.name==="Loyalty")!;
    expect(created.kind).toBe("percentage");
    expect(created.rateBasisPoints).toBe(1500);
    expect(created.amountMinor).toBeNull();

    // A percentage shows no second line: "Per appointment" under "15%" would be a fact about
    // money that is not true of a percentage.
    const row=page.locator('[data-discount-row][data-discount-name="Loyalty"]');
    await expect(row).toContainText("15%");
    await expect(row).not.toContainText("Per appointment");
  });

test("a live discount is edited rather than deleted and recreated",async({ page,request,tenant })=>{
  const created=await request.post("/api/settings/discounts",{
    data:{ name:"Senior discunt",kind:"amount",amountMinor:500,applyScope:"per_appointment" }
  });
  expect(created.ok(),await created.text()).toBeTruthy();
  const before=await readSettings(request);
  const id=before.discounts.find((discount)=>discount.name==="Senior discunt")!.id;

  await login(page,tenant.ownerEmail);
  await openDiscounts(page);

  const row=page.locator(`[data-discount-row="${id}"]`);
  await row.getByTestId("discount-row-actions").click();
  await row.getByTestId("discount-edit").click();
  await expect(page.getByTestId("field-name")).toHaveValue("Senior discunt");
  await expect(page.getByTestId("field-value")).toHaveValue("5.00");
  await page.getByTestId("field-name").fill("Senior discount");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  // THE SAME ROW, corrected. Delete-and-recreate would have severed the link every invoice that
  // applied it holds back to the discount that produced it.
  const after=await readSettings(request);
  const edited=after.discounts.find((discount)=>discount.id===id)!;
  expect(edited.name).toBe("Senior discount");
  expect(after.discounts).toHaveLength(1);

  // The Active switch writes, and the row it wrote comes back from the server.
  await page.locator(`[data-discount-row="${id}"]`).getByTestId("discount-enabled").uncheck();
  await expect.poll(async()=>{
    const settings=await readSettings(request);
    // A retired discount leaves the screen entirely: `active=false` is what delete means here.
    return settings.discounts.length;
  }).toBe(0);
});

test("a discount is retired rather than erased, and the confirmation says what survives",
  async({ page,request,tenant })=>{
    const created=await request.post("/api/settings/discounts",{
      data:{ name:"Puppy first groom",kind:"percentage",rateBasisPoints:2000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openDiscounts(page);

    const row=page.locator('[data-discount-row][data-discount-name="Puppy first groom"]');
    await row.getByTestId("discount-row-actions").click();
    await row.getByTestId("discount-delete").click();
    const dialog=page.getByTestId("stacked-dialog");
    await expect(dialog).toContainText("Invoices that already applied it keep the amount they took off");
    await dialog.getByTestId("stacked-dialog-confirm").click();

    await expect(page.getByTestId("discount-empty")).toBeVisible();
    const settings=await readSettings(request);
    expect(settings.discounts).toHaveLength(0);
  });

test("@smoke a coupon is built in the drawer, and its limitations read back as tokens",
  async({ page,request,tenant })=>{
    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await openCouponsTab(page);

    await page.getByTestId("coupon-add").click();
    const drawer=page.getByTestId("coupon-editor");
    await expect(drawer).toBeVisible();
    // The body is a form to fill, so focus lands where typing starts rather than on the panel.
    await expect(page.getByTestId("field-name")).toBeFocused();

    await page.getByTestId("field-name").fill("Spring cleaning");
    await page.getByTestId("field-code").fill("spring26");
    await page.getByTestId("field-value").fill("12.50");

    // Nothing is limited until a switch is thrown, and the summary says so in words.
    await expect(page.getByTestId("coupon-limit-summary"))
      .toHaveText("No limitations. Anyone can redeem this, any number of times.");

    await page.getByTestId("coupon-limit-dates").check();
    await page.getByTestId("field-startsOn").fill("2026-01-01");
    await page.getByTestId("field-endsOn").fill("2026-03-31");
    await page.getByTestId("coupon-limit-per-client").check();
    await page.getByTestId("field-maxRedemptionsPerClient").fill("1");
    await page.getByTestId("coupon-limit-days").check();
    for(const day of [1,2,3])await page.getByTestId(`coupon-day-${day}`).check();

    // The verbatim summary shape: dates, then the per-client cap, then the days.
    await expect(page.getByTestId("coupon-limit-summary"))
      .toHaveText("Limits: 1 Jan – 31 Mar · 1 per client · Mon, Tue, Wed");

    await page.getByTestId("coupon-editor-save").click();
    await expect(drawer).toBeHidden();

    const settings=await readSettings(request);
    const coupon=settings.coupons.find((entry)=>entry.code==="SPRING26")!;
    // Uppercased on submit: the code stored is the code on the card.
    expect(coupon.code).toBe("SPRING26");
    expect(coupon.amountMinor).toBe(1250);
    expect(coupon.startsOn).toBe("2026-01-01");
    expect(coupon.endsOn).toBe("2026-03-31");
    expect(coupon.weekdays).toEqual([1,2,3]);
    expect(coupon.maxRedemptionsPerClient).toBe(1);
    // Never switched on, so never sent. A hidden field would have carried a value anyway.
    expect(coupon.maxRedemptions).toBeNull();
    expect(coupon.newClientsOnly).toBe(false);

    const row=page.locator(`[data-coupon-row="${coupon.id}"]`);
    await expect(row.getByTestId("coupon-limits-cell")).toContainText("1 Jan – 31 Mar");
    await expect(row.getByTestId("coupon-limits-cell")).toContainText("1 per client");
    await expect(row.getByTestId("coupon-limits-cell")).toContainText("Mon, Tue, Wed");
    await expect(row).toContainText("SPRING26");
    await expect(row.getByTestId("coupon-enabled")).toBeChecked();
  });

test("a limitation switched off is disabled rather than hidden, and keeps what was typed",
  async({ page,request,tenant })=>{
    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await openCouponsTab(page);
    await page.getByTestId("coupon-add").click();

    const fields=page.locator("#coupon-limit-total-fields");
    const total=page.getByTestId("field-maxRedemptions");
    // On screen from the start, so the reader can see what checking the box is going to ask for.
    await expect(fields).toBeVisible();
    await expect(total).toBeDisabled();

    await page.getByTestId("coupon-limit-total").check();
    // Checking hands over to the thing it just turned on.
    await expect(total).toBeFocused();
    await total.fill("50");
    await expect(page.getByTestId("coupon-limit-summary")).toHaveText("Limits: 50 total");

    await page.getByTestId("coupon-limit-total").uncheck();
    await expect(fields).toBeVisible();
    await expect(total).toBeDisabled();
    // NOT CLEARED. Unchecking to look at the total is not a request to lose the number.
    await expect(total).toHaveValue("50");
    await expect(page.getByTestId("coupon-limit-summary"))
      .toHaveText("No limitations. Anyone can redeem this, any number of times.");

    await page.getByTestId("field-code").fill("NOCAP");
    await page.getByTestId("field-value").fill("5");
    await page.getByTestId("coupon-editor-save").click();
    await expect(page.getByTestId("coupon-editor")).toBeHidden();

    // A disabled fieldset is excluded from `FormData`, so the 50 that is still on screen never
    // reached the payload.
    const settings=await readSettings(request);
    expect(settings.coupons.find((coupon)=>coupon.code==="NOCAP")!.maxRedemptions).toBeNull();
  });

test("Generate writes a code a client can read aloud, and says so when it will overwrite one",
  async({ page,tenant })=>{
    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await openCouponsTab(page);
    await page.getByTestId("coupon-add").click();

    const generate=page.getByTestId("coupon-generate");
    const code=page.getByTestId("field-code");
    // The verb IS the warning, which is cheaper than a confirm for something one press undoes.
    await expect(generate).toHaveText("Generate");
    await generate.click();
    const first=await code.inputValue();
    expect(first).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    // I, L, O, 0 and 1 are the entire failure mode of a code read off a printed card.
    expect(first).not.toMatch(/[ILO01]/);
    await expect(generate).toHaveText("Regenerate");

    await generate.click();
    expect(await code.inputValue()).not.toBe(first);

    // Still fully editable: a salon may have printed SPRING26 before Pawsh ever saw it.
    await code.fill("");
    await expect(generate).toHaveText("Generate");
  });

test("a code that belonged to a retired coupon is refused with its own reason",
  async({ page,request,tenant })=>{
    const created=await request.post("/api/settings/coupons",{
      data:{ code:"WINTER25",kind:"amount",amountMinor:1000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();
    const before=await readSettings(request);
    const id=before.coupons.find((coupon)=>coupon.code==="WINTER25")!.id;
    const removed=await request.delete(`/api/settings/coupons/${id}`);
    expect(removed.status()).toBe(204);

    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await openCouponsTab(page);
    // Retired rows are not listed, so the collision is with something the operator cannot see.
    await expect(page.getByTestId("coupon-empty")).toBeVisible();

    await page.getByTestId("coupon-add").click();
    await page.getByTestId("field-code").fill("WINTER25");
    await page.getByTestId("field-value").fill("10");
    await page.getByTestId("coupon-editor-save").click();

    // "Already exists" over a coupon that is not on the screen is a dead end. This says which of
    // the two it is, and puts the cursor in the field that has to change.
    await expect(page.getByTestId("coupon-editor-error"))
      .toContainText("That code belonged to a retired coupon");
    await expect(page.getByTestId("coupon-editor")).toBeVisible();
    await expect(page.getByTestId("field-code")).toBeFocused();
  });

test("the stacking tab shows all three outcomes at once and saves the one chosen",
  async({ page,request,tenant })=>{
    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await page.getByTestId("discounts-tab-stacking").click();

    const example=page.getByTestId("stacking-example");
    await expect(example).toContainText("$100.00 appointment with a $20.00 discount and a 10% discount");

    // ALL THREE, with the chosen one marked: the operator is choosing between them, not confirming
    // one. $20/10% is the pair that makes the difference visible - $10/10% is $90 either way.
    const one=example.locator('[data-stacking-case="one_per_appointment"]');
    const amountFirst=example.locator('[data-stacking-case="amount_first"]');
    const percentageFirst=example.locator('[data-stacking-case="percentage_first"]');
    await expect(one).toContainText("$80.00 or $90.00");
    await expect(amountFirst).toContainText("$100.00 − $20.00 = $80.00, then 10% off");
    await expect(amountFirst).toContainText("$72.00");
    await expect(percentageFirst).toContainText("10% off = $90.00, then − $20.00");
    await expect(percentageFirst).toContainText("$70.00");

    // A new workspace allows one discount per appointment, which is what checkout did before this
    // feature existed.
    await expect(one).toHaveAttribute("aria-current","true");
    await expect(one).toContainText("Selected");

    await page.getByTestId("stacking-select").selectOption("percentage_first");
    await expect(percentageFirst).toHaveAttribute("aria-current","true");
    await expect(one).not.toHaveAttribute("aria-current","true");
    expect((await readSettings(request)).stackingMode).toBe("percentage_first");

    // The options say what they will do, not what they are called internally.
    const labels=await page.getByTestId("stacking-select").locator("option").allTextContents();
    expect(labels).toEqual([
      "One coupon or discount per appointment",
      "Apply amounts first, then percentages",
      "Apply percentages first, then amounts"
    ]);
  });

test("a member without settings.discounts is told they cannot view it, and can retry",
  async({ page,request,tenant })=>{
    const member=await createMember(
      request,`nodiscounts+${tenant.runId}@pawsh-test.example`,["calendar.view","settings.manage"]
    );

    await login(page,member.email,password);
    await openDiscounts(page);

    // The read is gated on the same key as the writes, so the server answers rather than the
    // client guessing from its own copy of a role.
    const error=page.getByTestId("discounts-error");
    await expect(error).toContainText("You do not have permission to view this.");
    await expect(page.getByTestId("discounts-retry")).toBeVisible();
    // The tabs stay usable: the failure belongs to the panel, not to the workspace.
    await expect(page.getByTestId("discounts-tab-coupon")).toBeEnabled();
  });

test("the workspace fits its column and keeps the tables scrollable rather than the page",
  async({ page,request,tenant },testInfo)=>{
    // Enough rows and enough tokens to push a table wider than the settings column.
    await request.post("/api/settings/discounts",{
      data:{ name:"A long standing loyalty reduction for regulars",kind:"amount",amountMinor:1500 }
    });
    await request.post("/api/settings/coupons",{
      data:{ code:"LONGCODE12345678",name:"Winter holiday welcome offer",kind:"percentage",
        rateBasisPoints:1250,startsOn:"2026-01-01",endsOn:"2026-12-31",weekdays:[1,3,5],
        maxRedemptions:250,maxRedemptionsPerClient:2,newClientsOnly:true }
    });

    await login(page,tenant.ownerEmail);
    await openDiscounts(page);
    await openCouponsTab(page);
    await expect(page.getByTestId("coupon-table")).toBeVisible();

    // `html,body{overflow-x:hidden}` is the contract; the table wrap is what carries the scroll.
    await expectNoDocumentOverflow(page,testInfo);
    await page.setViewportSize({ width:900,height:900 });
    await expectNoDocumentOverflow(page,testInfo);
    await page.setViewportSize({ width:390,height:844 });
    await expectNoDocumentOverflow(page,testInfo);

    // At phone width the code and the redemption count fold onto the Name line rather than
    // disappearing with their columns.
    await expect(page.getByTestId("coupon-row").locator(".taxpay-inline-type")).toContainText("LONGCODE12345678");
  });

test("the client directory's pager is the shared shell, not a second copy of it",
  async({ page,tenant })=>{
    // The settings tables that page had to draw the same arrows, so `<nav class="pager">` moved out
    // of `index.html` into `pagerNavMarkup` and the directory now fills a slot. Same landmark, same
    // label and the same three ids - this is what says so, because nothing else covered it.
    await login(page,tenant.ownerEmail);
    await page.getByTestId("nav-customers").click();
    const pager=page.locator("#customers nav.pager");
    await expect(pager).toHaveAttribute("aria-label","Client pages");
    await expect(pager.locator("#customer-prev")).toHaveAccessibleName("Previous page");
    await expect(pager.locator("#customer-next")).toHaveAccessibleName("Next page");
    await expect(pager.locator("#customer-pages .pager-page.current")).toHaveText("1");
    // The slot itself is gone: leaving it behind would mean the replacement never ran.
    await expect(page.locator("[data-pager-slot]")).toHaveCount(0);
  });

// --- Checkout, and what the receipt says afterwards -------------------------
// `GET /api/checkout/payment-options` carries the configured discounts, gated on `checkout.perform`
// with `discounts.apply` deciding WHAT comes back rather than whether anything does. The field is
// three-state and the null is the permission: `null` withholds the rows from an operator who
// cannot apply one, `[]` says the salon has configured none, `[...]` is the list. Coupons are not
// in it by design - a coupon is typed as a code, never picked - so the code field is unchanged.

async function openCheckout(page:Page,appointmentId:string):Promise<void> {
  await page.getByTestId("nav-calendar").click();
  const card=page.locator(`[data-appointment-id="${appointmentId}"]`);
  await expect(card).toBeVisible();
  // Arriving from another workspace reloads the calendar behind the click, which can detach a row
  // menu that has already been opened over it. Reopening the menu is steadier than guessing how
  // long that reload takes, and it is what a person would do anyway.
  await expect(async()=>{
    await (await appointmentAction(card,"appointment-completed")).click({ timeout:2_000 });
    await expect(page.getByTestId("checkout-surface")).toBeVisible({ timeout:2_000 });
  }).toPass({ timeout:15_000 });
}

test("a coupon is redeemed at checkout, and the receipt names what came off",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    const created=await request.post("/api/settings/coupons",{
      data:{ code:"TENOFF",name:"Ten off",kind:"amount",amountMinor:1000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);

    // Lower case in, upper case out: the index normalises it, so the operator does not have to.
    await openAdjustment(page,"coupon");
    await page.getByTestId("field-couponCode").fill("tenoff");
    await chooseMethod(page,"Cash");
    await page.getByTestId("checkout-submit").click();

    const receipt=page.getByTestId("receipt");
    await expect(receipt).toBeVisible();
    // Named by the coupon, not by the word "Discount": what came off and why is the whole point
    // of the breakdown.
    await expect(receipt.getByTestId("receipt-discount")).toHaveText("Ten off-$10.00");
    await expect(receipt).toContainText("Subtotal$85.00");
    // A single line needs no sum under it.
    await expect(receipt.getByTestId("receipt-discount-total")).toHaveCount(0);

    // The redemption is recorded against the coupon, which is what its cap counts.
    const settings=await readSettings(request);
    expect(settings.coupons.find((coupon)=>coupon.code==="TENOFF")!.redeemedCount).toBe(1);
  });

test("two discounts on one bill compound, and the receipt shows the steps in applied order",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    // Percentages first, so the 10% is taken off the full $85 and the $20 comes off what is left.
    // Amounts first would have produced a different total from the same two inputs, which is
    // exactly why this is a setting.
    const stacking=await request.put("/api/settings/discount-stacking",{
      data:{ stackingMode:"percentage_first" }
    });
    expect(stacking.ok(),await stacking.text()).toBeTruthy();
    const created=await request.post("/api/settings/coupons",{
      data:{ code:"TENPCT",name:"Ten percent",kind:"percentage",rateBasisPoints:1000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);
    await openAdjustment(page,"discount");
    await page.getByTestId("field-discount").fill("20");
    await openAdjustment(page,"coupon");
    await page.getByTestId("field-couponCode").fill("TENPCT");
    await chooseMethod(page,"Cash");
    await page.getByTestId("checkout-submit").click();

    const receipt=page.getByTestId("receipt");
    const lines=receipt.getByTestId("receipt-discount");
    await expect(lines).toHaveCount(2);
    // 10% of $85.00 first, then the flat $20 off what remained.
    await expect(lines.nth(0)).toHaveText("Ten percent 10%-$8.50");
    // The free-typed amount keeps rendering as "Discount", exactly as it always has - the
    // dialog sends "manual" as its type, and that token is never shown to anybody.
    await expect(lines.nth(1)).toHaveText("Discount-$20.00");
    // The sum appears once there is more than one thing to add up, and it is the figure the tax
    // underneath was taken after.
    await expect(receipt.getByTestId("receipt-discount-total")).toHaveText("Total discount-$28.50");
    await expect(receipt).toContainText("Subtotal$85.00");
  });

test("a coupon the client cannot use is refused in the server's own words",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    const created=await request.post("/api/settings/coupons",{
      data:{ code:"LASTYEAR",kind:"amount",amountMinor:500,endsOn:"2020-12-31" }
    });
    expect(created.ok(),await created.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);
    await openAdjustment(page,"coupon");
    await page.getByTestId("field-couponCode").fill("LASTYEAR");
    await chooseMethod(page,"Cash");
    await page.getByTestId("checkout-submit").click();

    // The refusal names the date rather than saying the code is wrong, and the screen stays open
    // on the operator's own input so the visit can still be checked out without it.
    await expect(page.locator("#checkout-error")).toContainText("expired on 2020-12-31");
    await expect(page.getByTestId("checkout-surface")).toBeVisible();
    await page.getByTestId("field-couponCode").fill("");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("receipt")).toBeVisible();
    // No coupon, no breakdown row: the receipt renders the line it has always rendered.
    await expect(page.getByTestId("receipt").getByTestId("receipt-discount")).toHaveText("Discount-$0.00");
  });

test("a cashier who may not grant money off can still honour a coupon",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    const created=await request.post("/api/settings/coupons",{
      data:{ code:"WELCOME",name:"Welcome",kind:"amount",amountMinor:750 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();
    // `checkout.perform` without `discounts.apply`: they take the money and honour what the
    // customer brings, and they do not decide to take anything off themselves.
    const member=await createMember(request,`cashier+${tenant.runId}@pawsh-test.example`,[
      "calendar.view","appointments.view","checkout.perform","payments.view","customers.view"
    ]);

    await login(page,member.email,password);
    await openCheckout(page,appointment.id);

    // Omitted, not disabled: a greyed field still asserts that granting a discount belongs on this
    // screen for this person, and it does not.
    await expect(page.getByTestId("field-discount")).toHaveCount(0);
    await openAdjustment(page,"coupon");
    await page.getByTestId("field-couponCode").fill("WELCOME");
    await chooseMethod(page,"Cash");
    await page.getByTestId("checkout-submit").click();

    await expect(page.getByTestId("receipt").getByTestId("receipt-discount")).toHaveText("Welcome-$7.50");
  });

test("@smoke the picker offers the salon's configured discounts and sends ids, never amounts",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    // Two, so the order can be checked: the payload is ordered `lower(name), id`, byte-identical
    // to the settings screen, so the picker and Settings are one list in one order.
    for(const data of [
      { name:"Senior discount",kind:"amount",amountMinor:1000,applyScope:"per_appointment" },
      { name:"Bring a friend",kind:"percentage",rateBasisPoints:1500 }
    ]){
      const created=await request.post("/api/settings/discounts",{ data });
      expect(created.ok(),await created.text()).toBeTruthy();
    }
    const settings=await readSettings(request);
    const senior=settings.discounts.find((discount)=>discount.name==="Senior discount")!;

    // Stacking has to allow more than one before the picker will let a second be chosen at all.
    const stacking=await request.put("/api/settings/discount-stacking",{
      data:{ stackingMode:"amount_first" }
    });
    expect(stacking.ok(),await stacking.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);

    await openAdjustment(page,"coupon");
    const picker=page.getByTestId("checkout-discounts");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId("checkout-discount")).toHaveCount(2);
    // Alphabetical, as the settings screen lists them.
    await expect(picker.locator("label").nth(0)).toContainText("Bring a friend");
    await expect(picker.locator("label").nth(0)).toContainText("15%");
    // A percentage reads back no apply scope, exactly as in the settings table.
    await expect(picker.locator("label").nth(0)).not.toContainText("Per appointment");
    await expect(picker.locator("label").nth(1)).toContainText("Senior discount");
    await expect(picker.locator("label").nth(1)).toContainText("$10.00 · Per appointment");

    // The request body carries ids and no amount: the server recomputes every figure.
    const [checkout]=await Promise.all([
      page.waitForRequest((sent)=>
        sent.url().includes(`/api/appointments/${appointment.id}/checkout`)
        && sent.method()==="POST"),
      (async()=>{
        await page.locator(`[data-checkout-discount="${senior.id}"]`).check();
        await chooseMethod(page,"Cash");
        await page.getByTestId("checkout-submit").click();
      })()
    ]);
    const body=JSON.parse(checkout.postData()!) as Record<string,unknown>;
    expect(body.appliedDiscountIds).toEqual([senior.id]);
    expect(body.discountMinor).toBe(0);
    expect(JSON.stringify(body)).not.toContain("amountMinor");

    await expect(page.getByTestId("receipt").getByTestId("receipt-discount"))
      .toHaveText("Senior discount-$10.00");
  });

test("the running total shows the compounding before the operator commits to it",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    await request.put("/api/settings/discount-stacking",{ data:{ stackingMode:"percentage_first" } });
    const created=await request.post("/api/settings/discounts",{
      data:{ name:"Ten percent",kind:"percentage",rateBasisPoints:1000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);

    await openAdjustment(page,"coupon");
    const total=page.getByTestId("checkout-discount-total");
    // Nothing taken off, nothing said: a permanent "$85.00 = $85.00" would be a line about the
    // product rather than about this visit.
    await expect(total).toHaveText("");

    await page.getByTestId("checkout-discount").check();
    await expect(total).toHaveText("$85.00 − $8.50 = $76.50 before tax");

    // The manual amount joins the same fold, and the percentage is taken FIRST because that is
    // what this salon is set to - $8.50 off $85.00, then $20.00 off what is left.
    await openAdjustment(page,"discount");
    await page.getByTestId("field-discount").fill("20");
    await expect(total).toHaveText("$85.00 − $28.50 = $56.50 before tax");

    // A coupon cannot be priced here - the server resolves it against the coupon row - so it is
    // named beside the figure rather than folded into it and quietly making it wrong.
    await page.getByTestId("field-couponCode").fill("MAYBE");
    await expect(total).toContainText("The coupon comes off on top when you check out.");

    await page.getByTestId("field-couponCode").fill("");
    await chooseMethod(page,"Cash");
    await page.getByTestId("checkout-submit").click();
    // The figure the operator was shown is the figure the invoice was built on.
    await expect(page.getByTestId("receipt").getByTestId("receipt-discount-total"))
      .toHaveText("Total discount-$28.50");
    await expect(page.getByTestId("receipt")).toContainText("Tax$4.66");
  });

test("one discount per appointment stops the operator at one instead of letting the server refuse",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    for(const name of ["Senior discount","Bring a friend"]){
      const created=await request.post("/api/settings/discounts",{
        data:{ name,kind:"amount",amountMinor:1000 }
      });
      expect(created.ok(),await created.text()).toBeTruthy();
    }
    // The default, and what checkout did before any of this existed.
    expect((await readSettings(request)).stackingMode).toBe("one_per_appointment");

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);

    // Said before the rule is hit, rather than discovered by a control going grey.
    await openAdjustment(page,"coupon");
    await openAdjustment(page,"discount");
    await expect(page.getByTestId("checkout-one-only"))
      .toHaveText("This salon applies one coupon or discount per appointment.");
    const rows=page.getByTestId("checkout-discount");
    await expect(rows.nth(0)).toBeEnabled();
    await expect(rows.nth(1)).toBeEnabled();

    await rows.nth(0).check();
    // Everything that is NOT carrying the selection goes inert - including the manual amount and
    // the coupon box, because the server counts all three together.
    await expect(rows.nth(1)).toBeDisabled();
    await expect(page.getByTestId("field-discount")).toBeDisabled();
    await expect(page.getByTestId("field-couponCode")).toBeDisabled();

    // Clearing the one that is set is the way back, and it is reversible.
    await rows.nth(0).uncheck();
    await expect(rows.nth(1)).toBeEnabled();
    await expect(page.getByTestId("field-discount")).toBeEnabled();

    // The same rule counts a typed coupon: a code in the box takes the one slot.
    await page.getByTestId("field-couponCode").fill("SOMECODE");
    await expect(rows.nth(0)).toBeDisabled();
    await expect(page.getByTestId("field-discount")).toBeDisabled();
    await page.getByTestId("field-couponCode").fill("");
    await expect(rows.nth(0)).toBeEnabled();
  });

test("a cashier who cannot grant money off gets no picker, not an empty one",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    const created=await request.post("/api/settings/discounts",{
      data:{ name:"Senior discount",kind:"amount",amountMinor:1000 }
    });
    expect(created.ok(),await created.text()).toBeTruthy();
    const member=await createMember(request,`nogrant+${tenant.runId}@pawsh-test.example`,[
      "calendar.view","appointments.view","checkout.perform","payments.view","customers.view"
    ]);

    await login(page,member.email,password);
    await openCheckout(page,appointment.id);

    // `discounts: null` renders NOTHING - not a disabled picker, and not the empty state, because
    // "you may not do this" and "there is nothing to do" are different sentences and this salon
    // has in fact configured one.
    await expect(page.getByTestId("checkout-discounts")).toHaveCount(0);
    await expect(page.getByTestId("checkout-discount-empty")).toHaveCount(0);
    await expect(page.getByTestId("field-discount")).toHaveCount(0);
    await expect(page.getByTestId("checkout-one-only")).toHaveCount(0);
    // The one thing they can still do, because a coupon was earned elsewhere and they are only
    // keying in a code.
    await openAdjustment(page,"coupon");
    await expect(page.getByTestId("field-couponCode")).toBeVisible();
  });

test("a salon with no discount configured says so rather than showing nothing",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    expect((await readSettings(request)).discounts).toHaveLength(0);

    await login(page,tenant.ownerEmail);
    await openCheckout(page,appointment.id);

    // `[]` is an empty state, not an absent one: this operator may apply a discount, and there is
    // none to apply.
    await expect(page.getByTestId("checkout-discounts")).toHaveCount(0);
    await expect(page.getByTestId("checkout-discount-empty"))
      .toHaveText("No discount is set up in Settings → Coupons & discounts.");
    // The ad-hoc path is untouched by any of this.
    await openAdjustment(page,"discount");
    await expect(page.getByTestId("field-discount")).toBeVisible();
  });

test("a discount configured in Settings reaches checkout without a reload",
  async({ page,request,tenant })=>{
    const appointment=await completeAppointment(request,tenant);
    await login(page,tenant.ownerEmail);

    // Open checkout once so the options are read and cached, then dismiss it.
    await openCheckout(page,appointment.id);
    await openAdjustment(page,"coupon");
    await expect(page.getByTestId("checkout-discount-empty")).toBeVisible();
    // Escape is the surface's own dismissal, and nothing was entered, so it costs no confirm.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("checkout-surface")).toBeHidden();

    await openDiscounts(page);
    await page.getByTestId("discount-add").click();
    await page.getByTestId("field-name").fill("Old Friend Discount");
    await page.getByTestId("field-value").fill("10.00");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // The cashier-facing copy is dropped on a settings write, so the picker is not still showing
    // the salon's configuration from a moment ago.
    await openCheckout(page,appointment.id);
    await openAdjustment(page,"coupon");
    await expect(page.getByTestId("checkout-discount")).toHaveCount(1);
    await expect(page.getByTestId("checkout-discounts")).toContainText("Old Friend Discount");
  });
