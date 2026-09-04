import { appointmentAction, createAppointment, test, expect, login } from "./fixtures/tenant.js";
import { expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { Page } from "@playwright/test";

/**
 * Settings → Business.
 *
 * Five tabs over one panel. The two working ones replace dialogs that each lost data quietly, and
 * those two failures are what most of this file is about:
 *
 *   - the hours dialog rendered a hardcoded Mon-Fri 09:00-17:00 without ever calling
 *     `GET /api/business/working-hours`, over a PUT that deletes and reinserts the whole location;
 *   - `PUT /api/business/settings` is a merge, and a payload naming `phone`/`email`/`address` when
 *     the operator did not touch them clears columns the save was never about.
 *
 * The fixture's stored week is Monday-Friday 08:00-18:00 and Saturday 09:00-16:00, chosen here
 * because it is not the week the retired dialog fabricated: an editor showing 09:00-17:00 on a
 * Monday is showing something it did not read.
 */

async function openBusiness(page: Page): Promise<void> {
  // Below the shell's breakpoint the primary nav sits behind the mobile toggle.
  if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-settings").isHidden()) {
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button",{name:"Business",exact:true}).click();
  await expect(page.getByTestId("business-tabs")).toBeVisible();
}
async function openBusinessHours(page: Page): Promise<void> {
  await openBusiness(page);
  await page.getByTestId("business-tab-hours").click();
  await expect(page.getByTestId("business-hours-list")).toBeVisible();
}

test("@smoke the tab bar moves focus with the arrows and activates only on commit",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  const info=page.getByTestId("business-tab-info");
  const number=page.getByTestId("business-tab-number");
  const billing=page.getByTestId("business-tab-billing");
  await expect(info).toHaveAttribute("aria-selected","true");
  await expect(info).toHaveAttribute("tabindex","0");
  await expect(number).toHaveAttribute("tabindex","-1");
  await expect(page.getByTestId("business-panel")).toHaveAttribute("aria-labelledby","business-tab-info");

  await info.focus();
  await page.keyboard.press("ArrowRight");
  // Focus moved; the panel did not. Activating on focus would swap the panel out from under
  // somebody simply passing along the bar.
  await expect(number).toBeFocused();
  await expect(info).toHaveAttribute("aria-selected","true");
  await expect(page.getByTestId("business-name")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(number).toHaveAttribute("aria-selected","true");
  await expect(info).toHaveAttribute("aria-selected","false");
  await expect(number).toHaveAttribute("tabindex","0");
  await expect(info).toHaveAttribute("tabindex","-1");
  await expect(page.getByTestId("business-panel")).toHaveAttribute("aria-labelledby","business-tab-number");
  await expect(number).toBeFocused();

  await page.keyboard.press("End");
  await expect(billing).toBeFocused();
  // Wrapping, and still only moving.
  await page.keyboard.press("ArrowRight");
  await expect(info).toBeFocused();
  await page.keyboard.press("Home");
  await expect(info).toBeFocused();
  await page.keyboard.press(" ");
  await expect(info).toHaveAttribute("aria-selected","true");

  // One Tab stop for the whole bar.
  expect(await page.locator('[data-business-tab][tabindex="0"]').count()).toBe(1);
});

test("@smoke the three unavailable tabs state their absence and offer nothing to configure",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  const unavailable: [string,string,string][] = [
    ["number","Pawsh Number","Pawsh does not provide phone numbers."],
    ["domain","Domain","Pawsh has no public client surface"],
    ["billing","Business Billing","Pawsh does not charge for itself from inside the product."]
  ];
  for (const [tab,heading,sentence] of unavailable) {
    await page.getByTestId(`business-tab-${tab}`).click();
    const panel=page.getByTestId("business-unavailable");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading",{name:heading})).toBeVisible();
    await expect(panel).toContainText("Not available");
    // A delivery promise is exactly what these are not.
    await expect(panel).not.toContainText("Coming soon");
    await expect(panel).toContainText(sentence);
    // No disabled input, no greyed select, no empty table, no skeleton: each would assert the
    // capability exists and is merely pending.
    expect(await panel.locator("input, select, textarea, table, [disabled]").count()).toBe(0);
    // The panel holds nothing focusable, so it is the tab stop for its own content.
    await expect(page.getByTestId("business-panel")).toHaveAttribute("tabindex","0");
  }

  // The pointer is what makes an empty tab read as deliberate rather than unfinished.
  await page.getByTestId("business-tab-billing").click();
  await page.getByRole("button",{name:"Open Tax & payments"}).click();
  await expect(page.getByTestId("taxpay-tabs")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/tax-payments$/);
});

test("@smoke the hours editor shows the hours that are stored, never a default week",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusinessHours(page);

  await expect(page.getByTestId("business-hours-scope"))
    .toContainText("These are the hours saved for");
  // The fixture's week, read back. 09:00-17:00 on a Monday would be the fabricated one.
  await expect(page.getByTestId("business-hours-start-1")).toHaveValue("08:00");
  await expect(page.getByTestId("business-hours-end-1")).toHaveValue("18:00");
  await expect(page.getByTestId("business-hours-start-6")).toHaveValue("09:00");
  await expect(page.getByTestId("business-hours-end-6")).toHaveValue("16:00");
  await expect(page.getByTestId("business-hours-open-1")).toBeChecked();
  // Sunday is not stored, and says so in a word rather than in a greyed-out input.
  await expect(page.getByTestId("business-hours-open-0")).not.toBeChecked();
  await expect(page.getByTestId("business-hours-state-0")).toHaveText("Closed");
  await expect(page.getByTestId("business-hours-start-0")).toHaveCount(0);
  await expect(page.getByTestId("business-hours-save")).toBeDisabled();

  // The switch is named without the row's day name doing the work.
  await expect(page.getByRole("switch",{name:"Open on Monday"})).toBeChecked();
  await expect(page.getByLabel("Monday opens at")).toHaveValue("08:00");
});

test("@smoke an invalid range is refused before the request and the week survives a save",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusinessHours(page);

  await page.getByTestId("business-hours-end-2").fill("07:00");
  await page.getByTestId("business-hours-start-2").focus();
  await expect(page.getByTestId("business-hours-row-error-2"))
    .toHaveText("Tuesday must close after it opens. Hours cannot run past midnight.");
  await expect(page.getByTestId("business-hours-status")).toHaveText("1 day changed.");

  await page.getByTestId("business-hours-save").click();
  await expect(page.getByTestId("business-hours-status")).toHaveText("Fix 1 day before saving.");
  // Nothing was sent, so the stored week is untouched.
  await expect(page.getByTestId("business-hours-save-error")).toHaveText("");

  await page.getByTestId("business-hours-end-2").fill("19:30");
  await page.getByTestId("business-hours-open-3").uncheck();
  await expect(page.getByTestId("business-hours-state-3")).toHaveText("Closed");
  await page.getByTestId("business-hours-save").click();
  await expect(page.locator("#toast")).toContainText("Business hours saved");
  await expect(page.getByTestId("business-hours-status")).toHaveText("Business hours saved.");

  await page.reload();
  await openBusinessHours(page);
  await expect(page.getByTestId("business-hours-end-2")).toHaveValue("19:30");
  await expect(page.getByTestId("business-hours-state-3")).toHaveText("Closed");
  // The whole-week payload is why the days nobody touched are still there: the PUT deletes and
  // reinserts the location's rows, so a changed-rows-only payload would drop these.
  await expect(page.getByTestId("business-hours-start-1")).toHaveValue("08:00");
  await expect(page.getByTestId("business-hours-end-6")).toHaveValue("16:00");
});

test("an unconfigured salon is told the calendar treats every slot as open",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  // Clear the week the fixture wrote, so the GET answers with nothing at all.
  await page.route("**/api/business/working-hours",async route=>{
    if (route.request().method()!=="GET") return route.fallback();
    await route.fulfill({status:200,contentType:"application/json",body:"[]"});
  });
  await openBusinessHours(page);

  const scope=page.getByTestId("business-hours-scope");
  await expect(scope).toContainText("No business hours are saved for");
  await expect(scope).toContainText("the calendar treats every slot on every day as open");
  await expect(scope).not.toContainText("These are the hours saved for");
  for (let day=0; day<7; day+=1) {
    await expect(page.getByTestId(`business-hours-open-${day}`)).not.toBeChecked();
    await expect(page.getByTestId(`business-hours-state-${day}`)).toHaveText("Closed");
  }
  await expect(page.getByTestId("business-hours-save")).toBeDisabled();
});

test("a weekday with two saved periods is shown read-only rather than half-deleted",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  // `business_hours` carries `unique (location_id, weekday)`, so this shape cannot be created
  // through the API. It is served here because the client must be incapable of destroying it if
  // that constraint is ever relaxed - a one-range editor reads the first period and Save drops
  // the rest, which is the same failure as the hardcoded grid, only quieter.
  await page.route("**/api/business/working-hours",async route=>{
    if (route.request().method()!=="GET") return route.fallback();
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify([
      {weekday:1,startTime:"08:00",endTime:"18:00"},
      {weekday:6,startTime:"09:00",endTime:"12:00"},
      {weekday:6,startTime:"13:00",endTime:"17:00"}
    ])});
  });
  await openBusinessHours(page);

  const saturday=page.getByTestId("business-hours-multi-6");
  await expect(saturday).toContainText("09:00–12:00, 13:00–17:00");
  await expect(saturday).toContainText("Two periods — editing here would remove one.");
  // No switch and no inputs: a control the editor cannot redraw would offer to destroy a period
  // it has no way to express.
  await expect(page.getByTestId("business-hours-open-6")).toHaveCount(0);
  await expect(page.getByTestId("business-hours-start-6")).toHaveCount(0);
  // Monday is still editable beside it.
  await expect(page.getByTestId("business-hours-start-1")).toHaveValue("08:00");
});

test("@smoke saving the salon name preserves the phone, email and address beside it",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  await expect(page.getByTestId("business-name")).toHaveValue(/PW Smoke/);
  await expect(page.getByTestId("business-save")).toBeDisabled();

  await page.getByTestId("business-phone").fill("626-555-0199");
  await page.getByTestId("business-email").fill(`salon+${tenant.runId}@pawsh-test.example`);
  await page.getByTestId("business-address").fill("18 Mill Lane, Riverside");
  await expect(page.getByTestId("business-status")).toHaveText("Unsaved changes.");
  await expect(page.getByTestId("business-save")).toBeEnabled();
  await page.getByTestId("business-save").click();
  await expect(page.locator("#toast")).toContainText("Business settings saved");
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");

  // The save that matters: a rename naming nothing else. The previous handler wrote
  // `phone = null, email = null` on every one of these.
  await page.getByTestId("business-name").fill(`QA Salon ${tenant.runId}`);
  await page.getByTestId("business-save").click();
  await expect(page.locator("#account-role")).toContainText(`QA Salon ${tenant.runId}`);

  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-name")).toHaveValue(`QA Salon ${tenant.runId}`);
  await expect(page.getByTestId("business-phone")).toHaveValue("626-555-0199");
  await expect(page.getByTestId("business-email")).toHaveValue(`salon+${tenant.runId}@pawsh-test.example`);
  await expect(page.getByTestId("business-address")).toHaveValue("18 Mill Lane, Riverside");

  // And clearing one is still possible, because a blank field is an explicit null rather than an
  // omission.
  await page.getByTestId("business-phone").fill("");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-phone")).toHaveValue("");
  await expect(page.getByTestId("business-email")).toHaveValue(`salon+${tenant.runId}@pawsh-test.example`);
});

test("Info refuses what it cannot save and says so on the field",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  await page.getByTestId("business-name").fill("R");
  await page.getByTestId("business-email").fill("desk@");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-field-error-name"))
    .toHaveText("A salon name is needed — it is what appears on every invoice.");
  await expect(page.getByTestId("business-field-error-email"))
    .toHaveText("That is not an email address Pawsh can send to.");
  await expect(page.getByTestId("business-name")).toHaveAttribute("aria-invalid","true");
  await expect(page.getByTestId("business-name")).toBeFocused();
  // One message per problem: the fields carry it, so the foot stays quiet.
  await expect(page.getByTestId("business-status")).toHaveText("");
  await expect(page.getByTestId("business-error")).toHaveText("");
});

test("changing the timezone asks first, every time",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  // Unconditional, unlike the retired dialog: its gate read `state.appointments`, which holds only
  // the calendar range in memory and is empty for somebody who went straight to Settings.
  await page.getByTestId("business-timezone").selectOption("America/Denver");
  await page.getByTestId("business-save").click();
  const dialog=page.getByTestId("stacked-dialog-confirm");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#stacked-dialog-body")).toContainText("America/Denver");
  await expect(page.locator("#stacked-dialog-body")).toContainText("America/Los_Angeles");
  await page.getByTestId("stacked-dialog-dismiss").click();
  // Dismissing keeps the draft rather than reverting it.
  await expect(page.getByTestId("business-timezone")).toHaveValue("America/Denver");

  await page.getByTestId("business-save").click();
  await dialog.click();
  await expect(page.locator("#toast")).toContainText("Business settings saved");
  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-timezone")).toHaveValue("America/Denver");
});

test("a settings save the server refuses as stale keeps the draft and offers the reload",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  // `locations.version` moves on every booking, blocked time and settings save, so this is what
  // an operator with the form open in a second tab actually gets.
  await page.route("**/api/business/settings",async route=>{
    if (route.request().method()!=="PUT") return route.fallback();
    await route.fulfill({status:409,contentType:"application/json",
      body:JSON.stringify({code:"STALE_LOCATION_SETTINGS",error:"Location settings changed. Refresh and try again."})});
  });
  await page.getByTestId("business-name").fill("Renamed While Stale");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-error"))
    .toHaveText("Business settings were changed somewhere else while this form was open. Reload the saved values and make the change again.");
  // Nothing the operator typed is discarded without them pressing the button.
  await expect(page.getByTestId("business-name")).toHaveValue("Renamed While Stale");

  await page.unroute("**/api/business/settings");
  await page.getByTestId("business-reload").click();
  await expect(page.getByTestId("business-status")).toHaveText("Saved values reloaded.");
  await expect(page.getByTestId("business-name")).toHaveValue(/PW Smoke/);
  await expect(page.getByTestId("business-reload")).toHaveCount(0);
});

test("a working-hours refusal is surfaced by name rather than as something generic",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  // A weekday holding two periods is passed through untouched, and `refuseInvalidWorkingHours`
  // answers with DUPLICATE_WORKING_HOURS_DAY naming the day. The refusal is real: this asks the
  // server, so the sentence on screen is the server's.
  await page.route("**/api/business/working-hours",async route=>{
    if (route.request().method()!=="GET") return route.fallback();
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify([
      {weekday:1,startTime:"08:00",endTime:"18:00"},
      {weekday:6,startTime:"09:00",endTime:"12:00"},
      {weekday:6,startTime:"13:00",endTime:"17:00"}
    ])});
  });
  await openBusinessHours(page);

  await page.getByTestId("business-hours-end-1").fill("19:00");
  await page.getByTestId("business-hours-save").click();
  const error=page.getByTestId("business-hours-save-error");
  await expect(error).toContainText("Saturday is listed more than once.");
  await expect(error).toContainText("Pawsh stores one opening period per day");
  // The draft is untouched, so the operator can still see what they asked for.
  await expect(page.getByTestId("business-hours-end-1")).toHaveValue("19:00");
  await expect(page.getByTestId("business-hours-save")).toBeEnabled();
});

test("the Salon view's Business hours entry points open the workspace on that tab",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.goto("/");
  await page.getByTestId("nav-setup").click();
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await page.getByRole("button",{name:/Manage hours/}).click();

  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await expect(page.getByTestId("business-tab-hours")).toHaveAttribute("aria-selected","true");
  await expect(page.getByTestId("business-hours-list")).toBeVisible();
  // The URL carries the category and makes no claim about the tab: `settingsPathCategory` matches
  // one path segment, so a second one would land the operator on Account.
  await expect(page).toHaveURL(/\/settings\/business$/);
});

test("@cross-browser the workspace reflows on a phone without overflowing",async({page,tenant},testInfo)=>{
  await page.setViewportSize({width:360,height:780});
  await login(page,tenant.ownerEmail);
  await openBusinessHours(page);
  await expect(page.getByTestId("business-hours-start-1")).toBeVisible();
  await expectNoDocumentOverflow(page,testInfo);
  await page.getByTestId("business-tab-info").click();
  await expect(page.getByTestId("business-name")).toBeVisible();
  await expectNoDocumentOverflow(page,testInfo);
});

test("@smoke every preference on the Info tab saves and comes back",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  // The column defaults, before anything is chosen. A control rendering something else here would
  // be showing a value the workspace does not hold.
  await expect(page.getByTestId("business-type")).toHaveValue("salon");
  await expect(page.getByTestId("business-date-format")).toHaveValue("MM/DD/YYYY");
  await expect(page.getByTestId("business-hour-format")).toHaveValue("12");
  await expect(page.getByTestId("business-weight-unit")).toHaveValue("lb");
  await expect(page.getByTestId("business-appointment-lock")).toHaveValue("disabled");
  // No coupon-stacking control here any more. It wrote `coupon_stacking`, which nothing that
  // calculates a bill has ever read; the rule that does decide money is `discount_stacking_mode`
  // and it belongs to the Coupons & discounts screen, under `settings.discounts`. Two controls for
  // one rule is how an operator comes to believe they have set something they have not.
  await expect(page.getByTestId("business-coupon-stacking")).toHaveCount(0);
  // `upcoming_appointment_count` is null, and null is the value All rather than an absence.
  await expect(page.getByTestId("business-upcoming-count")).toHaveValue("All");
  await expect(page.getByTestId("business-service-frequency")).toHaveValue("");
  await expect(page.getByTestId("business-save")).toBeDisabled();

  await page.getByTestId("business-website").fill("www.riverside.example");
  await page.getByTestId("business-type").selectOption("hybrid");
  await page.getByTestId("business-date-format").selectOption("DD/MM/YYYY");
  await page.getByTestId("business-hour-format").selectOption("24");
  await page.getByTestId("business-weight-unit").selectOption("kg");
  await page.getByTestId("business-appointment-lock").selectOption("enabled");
  await page.getByTestId("business-upcoming-count").selectOption("7");
  await page.getByTestId("business-service-frequency").fill("6");
  await page.getByTestId("business-social-facebook").fill("https://facebook.com/riverside");
  await page.getByTestId("business-social-google").fill("https://g.page/riverside");
  await page.getByTestId("business-social-yelp").fill("www.yelp.com/biz/riverside");
  await expect(page.getByTestId("business-status")).toHaveText("Unsaved changes.");
  await page.getByTestId("business-save").click();
  await expect(page.locator("#toast")).toContainText("Business settings saved");

  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-type")).toHaveValue("hybrid");
  await expect(page.getByTestId("business-date-format")).toHaveValue("DD/MM/YYYY");
  await expect(page.getByTestId("business-hour-format")).toHaveValue("24");
  await expect(page.getByTestId("business-weight-unit")).toHaveValue("kg");
  await expect(page.getByTestId("business-appointment-lock")).toHaveValue("enabled");
  await expect(page.getByTestId("business-upcoming-count")).toHaveValue("7");
  await expect(page.getByTestId("business-service-frequency")).toHaveValue("6");
  // A bare host is stored with https:// in front of it, and the operator is shown what came back.
  await expect(page.getByTestId("business-website")).toHaveValue("https://www.riverside.example");
  await expect(page.getByTestId("business-social-yelp")).toHaveValue("https://www.yelp.com/biz/riverside");
  await expect(page.getByTestId("business-social-facebook")).toHaveValue("https://facebook.com/riverside");
  await expect(page.getByTestId("business-save")).toBeDisabled();

  // And a save about the NAME alone leaves all twelve of them exactly where they are: the schema
  // is a merge, so an untouched field must be absent from the payload rather than sent as null.
  await page.getByTestId("business-name").fill(`Merge Check ${tenant.runId}`);
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-type")).toHaveValue("hybrid");
  await expect(page.getByTestId("business-weight-unit")).toHaveValue("kg");
  await expect(page.getByTestId("business-upcoming-count")).toHaveValue("7");
  await expect(page.getByTestId("business-social-google")).toHaveValue("https://g.page/riverside");
  await expect(page.getByTestId("business-website")).toHaveValue("https://www.riverside.example");

  // Clearing an optional preference is still possible: blank is an explicit null, not an omission.
  await page.getByTestId("business-service-frequency").fill("");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await openBusiness(page);
  await expect(page.getByTestId("business-service-frequency")).toHaveValue("");
  await expect(page.getByTestId("business-upcoming-count")).toHaveValue("7");
});

test("@smoke both long pickers filter, and neither can hide the stored value",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  const currency=page.getByTestId("business-currency");
  const currencyCount=page.getByTestId("business-currency-count");
  // 132 codes, served by `/api/me`. Nothing about that list is written in the client.
  await expect(currencyCount).toHaveText(/^\d{3} currencies\.$/);
  const total=Number((await currencyCount.textContent())?.match(/^(\d+)/)?.[1]);
  expect(total).toBeGreaterThan(100);
  expect(await currency.locator("option").count()).toBe(total);

  await page.getByTestId("business-currency-filter").fill("eur");
  // Two, not one: EUR matched, and the stored USD is kept alongside it. A select whose selected
  // option had been filtered away would report - and next save, store - a code nobody chose.
  await expect(currencyCount).toHaveText(`2 of ${total} currencies shown.`);
  await expect(currency.locator("option")).toHaveCount(2);
  await expect(currency.locator("option")).toHaveText(["USD","EUR"]);
  // Narrowing is not editing: the Save button must not light up for a filter keystroke.
  await expect(page.getByTestId("business-save")).toBeDisabled();
  await expect(currency).toHaveValue("USD");

  // A filter matching nothing still leaves the stored value selectable, because a select whose
  // selected option was filtered away would report - and next save, store - a different code.
  await page.getByTestId("business-currency-filter").fill("zzzz");
  await expect(currency.locator("option")).toHaveCount(1);
  await expect(currency).toHaveValue("USD");

  await page.getByTestId("business-currency-filter").fill("gbp");
  await currency.selectOption("GBP");
  await expect(page.getByTestId("business-save")).toBeEnabled();
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");

  // The timezone picker carries the same affordance.
  const timezone=page.getByTestId("business-timezone");
  await expect(page.getByTestId("business-timezone-count")).toHaveText(/^\d+ timezones\.$/);
  await page.getByTestId("business-timezone-filter").fill("los_ang");
  await expect(timezone.locator("option")).toHaveCount(1);
  await expect(timezone).toHaveValue("America/Los_Angeles");
  await page.getByTestId("business-timezone-filter").fill("");
  // Grouped by region, so an unfiltered list of ~420 identifiers is still navigable. Counted
  // rather than asserted visible: a closed select's contents are not rendered.
  expect(await timezone.locator("optgroup").count()).toBeGreaterThan(5);
  await expect(timezone.locator('optgroup[label="America"]')).toHaveCount(1);
  await expect(timezone).toHaveValue("America/Los_Angeles");
});

test("business type is required, and a hostile link is refused at the field",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  const type=page.getByTestId("business-type");
  await expect(type).toHaveAttribute("required","");
  // No blank option: the column is `not null`, so there is no state in which the operator is
  // choosing "none", and offering one would invent it.
  await expect(type.locator('option[value=""]')).toHaveCount(0);
  await expect(type.locator("option")).toHaveCount(3);

  // These four fields are rendered as links, so the schema 400s on anything but http/https. The
  // client refuses the same set at the field rather than sending a value it knows will be refused.
  await page.getByTestId("business-social-google").fill("javascript:alert(1)");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-field-error-socialGoogle"))
    .toHaveText("Pawsh stores web addresses only. Start it with https:// or leave the scheme off entirely.");
  await expect(page.getByTestId("business-social-google")).toHaveAttribute("aria-invalid","true");
  await expect(page.getByTestId("business-social-google")).toBeFocused();
  // One message per problem: the field carries it, so the foot stays quiet.
  await expect(page.getByTestId("business-status")).toHaveText("");
  await expect(page.getByTestId("business-error")).toHaveText("");

  await page.getByTestId("business-service-frequency").fill("0");
  await page.getByTestId("business-social-google").fill("https://g.page/riverside");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-field-error-defaultServiceFrequencyWeeks"))
    .toHaveText("Enter a whole number of weeks, from 1 to 104.");
});

test("the one inert setting says so, without promising a date",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);

  await expect(page.getByTestId("business-note-upcoming-count"))
    .toContainText("Pawsh has no send-out link");
  await expect(page.getByTestId("business-note-upcoming-count"))
    .toContainText("stored now and takes effect when there is one");
  // ONE, not two. The coupon-stacking control and its note are gone: the note said the choice
  // would take effect when coupons shipped, coupons shipped, and the choice still reached nothing
  // that calculates a bill. A caveat that has come true and stayed false is worse than no control.
  await expect(page.locator(".business-pending-note")).toHaveCount(1);
  await expect(page.getByTestId("business-note-coupon-stacking")).toHaveCount(0);
  await expect(page.getByTestId("business-panel")).not.toContainText("multiple coupons");
  // The appointment lock is not one of them either: it is enforced, so it carries an ordinary hint
  // describing what it does rather than a caveat about what it does not.
  await expect(page.getByTestId("business-note-appointment-lock")).toHaveCount(0);
  await expect(page.getByTestId("business-panel"))
    .toContainText("Enable Lock stops appointments being moved");
  await expect(page.getByTestId("business-panel")).not.toContainText("has not been decided");
  // The three unavailable tabs' voice, carried onto a working form: no delivery promise anywhere.
  await expect(page.getByTestId("business-panel")).not.toContainText("Coming soon");

  // The controls are ordinary controls. A disabled select would say the capability exists and is
  // merely switched off, which is the opposite of what the sentence beside it says.
  await expect(page.getByTestId("business-upcoming-count")).toBeEnabled();
  await expect(page.getByTestId("business-appointment-lock")).toBeEnabled();
});

test("choosing kilograms re-captions the price bands and the pet weights together",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  // A tiered service, because the six band captions only render for one. The bands are defined in
  // OUNCES and were chosen in pounds; the captions used to be hand-copied beside them.
  const tiered=await page.request.post("/api/services",{data:{
    name:`Tiered Groom ${tenant.runId}`,baseDurationMinutes:90,basePriceMinor:8500,pricingMode:"TIERED"
  }});
  expect(tiered.ok(),await tiered.text()).toBeTruthy();

  await page.getByTestId("header-services").click();
  await expect(page.getByTestId("services-view")).toBeVisible();
  const matrix=page.locator(".pricing-matrix").first();
  await expect(matrix).toContainText("1–20 lb");
  await expect(matrix).toContainText("100+ lb");

  await openBusiness(page);
  await page.getByTestId("business-weight-unit").selectOption("kg");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");

  await page.reload();
  await page.getByTestId("header-services").click();
  await expect(page.getByTestId("services-view")).toBeVisible();
  const converted=page.locator(".pricing-matrix").first();
  // Derived from the same ounce bounds the pricing resolver compares against, not from a second
  // list: 320 oz genuinely is 9.07 kg, and rounding it to a tidy 9 would move a price boundary.
  await expect(converted).toContainText("0.1–9.1 kg");
  await expect(converted).toContainText("45.4+ kg");
  await expect(converted).not.toContainText(" lb");

  // And the pet weights moved with them. A 19.1 kg dog under a column headed "21-40 lb" is worse
  // than converting nothing, because the operator cannot tell which of the three is wrong.
  await page.getByTestId("nav-customers").click();
  await expect(page.getByTestId("customers-view")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/\d+ lb\b/);
});

test("choosing DD/MM/YYYY and 24 Hours changes what the operator reads",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openBusiness(page);
  await page.getByTestId("business-date-format").selectOption("DD/MM/YYYY");
  await page.getByTestId("business-hour-format").selectOption("24");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");

  // A preference that changes nothing on screen is worse than no preference. The day view's range
  // header is the shortest path to both settings at once.
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("calendar")).toBeVisible();
  await page.locator("#calendar-view-select").selectOption("day");
  // "Wednesday, 02/09/2026" - the weekday stays in English because neither setting is about it,
  // exactly as `formatPreferredDateTime` renders it in the mail Pawsh sends.
  await expect(page.locator("#calendar-range")).toHaveText(/^[A-Z][a-z]+day, \d{2}\/\d{2}\/\d{4}$/);
  // The time axis is on the 24-hour clock, so no meridiem survives anywhere on the grid.
  await expect(page.getByTestId("calendar-list")).not.toContainText(/\d\s?[AP]M/);

  // And back the other way, so the assertion above is about the setting rather than the locale
  // this browser happens to run under.
  await openBusiness(page);
  await page.getByTestId("business-hour-format").selectOption("12");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await page.locator("#calendar-view-select").selectOption("day");
  await expect(page.getByTestId("calendar-list")).toContainText(/\d\s?[AP]M/);
});

async function setAppointmentLock(page: Page, value: "enabled"|"disabled"): Promise<void> {
  await openBusiness(page);
  await page.getByTestId("business-appointment-lock").selectOption(value);
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
}

test("@smoke the lock takes the move affordance away and says why",async({page,request,tenant})=>{
  const appointment=await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");

  const card=page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`);
  // Unlocked: the drag affordance is on the card and Move is in its menu.
  await expect(card).toHaveAttribute("data-draggable","true");
  await expect(await appointmentAction(card,"appointment-scheduled")).toBeVisible();
  await expect(page.getByRole("menuitem",{name:"Move"})).toBeVisible();
  await page.keyboard.press("Escape");

  await setAppointmentLock(page,"enabled");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");

  const locked=page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`);
  // The affordance is gone rather than left to fail: a drag that reached the server would come
  // back 409 with nothing on screen to act on. The lock binds the owner too - there is no bypass
  // here because there is none on the server, and one would draw a drag that snaps back silently.
  await expect(locked).not.toHaveAttribute("data-draggable","true");
  await (await appointmentAction(locked,"appointment-scheduled")).waitFor();
  await expect(page.getByRole("menuitem",{name:"Move"})).toHaveCount(0);
  // And in the slot Move vacated, the reason.
  const note=page.getByTestId("appointment-lock-note").filter({visible:true});
  await expect(note).toContainText("Appointments are locked from being moved.");
  await expect(note).toContainText("Settings → Business");

  // Nothing else is gated. Editing services, changing status and booking are not moves.
  await expect(page.getByTestId("appointment-scheduled")).toBeVisible();
  await expect(page.getByTestId("calendar-add-appointment")).toBeEnabled();

  // The appointment detail is the other place Move is offered, and it answers the same question.
  //
  // THESE ASSERTIONS MOVED, THEY WERE NOT WEAKENED. They were written against the shared `#modal`
  // appointment detail. That screen no longer exists: the appointment detail is now the full-screen
  // `#appointment-detail` surface, one level of the appointment stack, and the client sits in its
  // persistent rail instead of behind a footer button. So the same three facts - Move withheld, the
  // note explaining why, the neighbours undisturbed - are asked of the surface. The lock coverage is
  // the same coverage, aimed at where the screen went.
  await page.keyboard.press("Escape");
  await locked.locator(".calendar-open").click();
  const surface=page.locator("#appointment-detail");
  await expect(surface).toBeVisible();
  // Move on the surface is the pencil beside Groomer, and it is withheld exactly as the card menu's
  // Move is - absent rather than present and refused.
  await expect(surface.getByTestId("appointment-groomer-edit")).toHaveCount(0);
  const surfaceNote=surface.getByTestId("appointment-detail-lock-note");
  await expect(surfaceNote).toContainText("Appointments are locked from being moved.");
  await expect(surfaceNote).toContainText("Settings → Business");
  // Its neighbours are untouched. The surface has no footer "View client" button to check - reaching
  // the client is the rail, which is always on screen - so the rail and the groomer line the note
  // sits under are what it must not have displaced.
  await expect(surface.getByTestId("appointment-client-rail")).toBeVisible();
  await expect(surface.getByTestId("appointment-groomer")).toBeVisible();
  await surface.getByRole("button",{name:"Close appointment details"}).click();
  await expect(surface).toBeHidden();

  // The pointer is drawn for somebody who can act on it, and it goes where it says.
  await (await appointmentAction(locked,"appointment-scheduled")).waitFor();
  await note.getByRole("button",{name:"Open Settings"}).click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await expect(page.getByTestId("business-appointment-lock")).toHaveValue("enabled");

  // The surface carries the same pointer, and leaving through it is navigation away from the visit:
  // the stack comes down first, rather than leaving Settings rendering underneath an open dialog.
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await locked.locator(".calendar-open").click();
  await expect(surface).toBeVisible();
  await surface.getByRole("button",{name:"Open Settings"}).click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await expect(surface).toBeHidden();
  await expect(page.getByTestId("business-appointment-lock")).toHaveValue("enabled");

  // Unlocking hands the affordance back.
  await setAppointmentLock(page,"disabled");
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`))
    .toHaveAttribute("data-draggable","true");
});

test("a move refused by a lock this tab had not seen explains itself and redraws",async({page,request,tenant})=>{
  const appointment=await createAppointment(request,tenant,{localStart:`${tenant.anchor}T09:00`});
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`))
    .toHaveAttribute("data-draggable","true");

  // Hiding the affordance is not enforcement. A second tab, or a manager flipping the switch
  // mid-drag, both reach the server with the lock on - so the refusal has to read as an
  // explanation rather than as a generic failure.
  await page.route("**/api/appointments/*/schedule",async route=>{
    if (route.request().method()!=="PATCH") return route.fallback();
    await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({
      code:"APPOINTMENT_MOVE_LOCKED",
      error:"Appointments are locked from being moved. A manager can unlock this in Settings → Business."
    })});
  });

  const card=page.locator(`.week-appointment[data-appointment-id="${appointment.id}"]`);
  await (await appointmentAction(card,"appointment-scheduled")).waitFor();
  await page.getByRole("menuitem",{name:"Move"}).click();
  await expect(page.getByTestId("modal")).toBeVisible();
  await page.locator('[name="startAt"]').fill(`${tenant.anchor}T13:00`);
  await page.getByTestId("modal-submit").click();
  // The server's own sentence, verbatim, because it is written to be read by an operator.
  await expect(page.locator("#modal-error"))
    .toHaveText("Appointments are locked from being moved. A manager can unlock this in Settings → Business.");
  // A refused move writes nothing, so the appointment is still where it was.
  await expect(page.locator('[name="startAt"]')).toHaveValue(`${tenant.anchor}T13:00`);
});
