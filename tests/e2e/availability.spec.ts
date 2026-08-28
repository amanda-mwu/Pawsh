import { createMember, test, expect, login } from "./fixtures/tenant.js";
import { bookAppointment } from "./helpers/booking.js";
import { expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { Page } from "@playwright/test";

/**
 * Settings → Availability.
 *
 * The screen carries two scopes at once — workspace-wide groomer hours and per-location closed
 * days — so these cover the two things that go wrong when that distinction is lost: a week that
 * does not survive the round trip, and a closed day that a booking gets past anyway.
 */

async function openAvailability(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button",{name:"Availability",exact:true}).click();
  await expect(page.getByTestId("availability-tabs")).toBeVisible();
}

/** Step the closure calendar forward until the month holding `localDate` is on screen. */
async function showClosureMonth(page: Page,localDate: string): Promise<void> {
  // Compare month labels rather than racing on the day cells: the panel renders a loading line
  // before the grid, so a bare existence check can step past the month it is already showing.
  const label=new Intl.DateTimeFormat("en-US",{month:"long",year:"numeric",timeZone:"UTC"})
    .format(new Date(`${localDate}T12:00:00Z`));
  const heading=page.getByTestId("availability-month");
  for (let step=0; step<12; step+=1) {
    await expect(page.getByTestId("availability-closed-grid")).toBeVisible();
    if (await heading.textContent()===label) break;
    await page.getByRole("button",{name:"Next month"}).click();
  }
  await expect(heading).toHaveText(label);
  await expect(page.locator(`[data-availability-day="${localDate}"]`)).toHaveCount(1);
}

test("@smoke default working hours edit a whole week and survive a reload",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openAvailability(page);

  // The fixture puts Grace on 08:00-18:00, Monday through Friday.
  const wednesday=page.getByRole("gridcell",{name:/^Grace Groomer, Wednesday/});
  await expect(wednesday).toContainText("8:00–6:00 PM");
  await expect(page.getByTestId("availability-grid")).toContainText("1 at a time");

  await wednesday.click();
  const editor=page.getByTestId("availability-editor");
  await expect(editor).toBeVisible();
  // Focus opens on the field the operator is here to change.
  await expect(page.getByTestId("availability-start")).toBeFocused();

  await page.getByTestId("availability-start").fill("10:00");
  await page.getByTestId("availability-end").fill("09:00");
  await page.getByTestId("availability-save").click();
  await expect(editor.locator(".error")).toHaveText("The end time must be later than the start time.");
  await expect(editor).toBeVisible();

  await page.getByTestId("availability-end").fill("15:00");
  // One request for two days: the chip row is the reason the grid replaces a per-groomer dialog.
  await editor.locator('input[data-availability-day="4"]').check();
  await page.getByTestId("availability-save").click();

  await expect(page.locator("#toast")).toContainText("Grace Groomer's working hours saved.");
  await expect(page.getByTestId("availability-editor")).toHaveCount(0);
  await expect(wednesday).toContainText("10:00–3:00 PM");
  await expect(page.getByRole("gridcell",{name:/^Grace Groomer, Thursday/})).toContainText("10:00–3:00 PM");
  // Untouched days are left exactly as they were, not rewritten by the whole-week replace.
  await expect(page.getByRole("gridcell",{name:/^Grace Groomer, Tuesday/})).toContainText("8:00–6:00 PM");

  await page.reload();
  await expect(page.getByTestId("availability-tabs")).toBeVisible();
  await expect(page.getByRole("gridcell",{name:/^Grace Groomer, Wednesday/})).toContainText("10:00–3:00 PM");
  await expect(page.getByRole("gridcell",{name:/^Grace Groomer, Thursday/})).toContainText("10:00–3:00 PM");

  // Turning a day off is the other half of the same save, and it reads as Off rather than blank.
  await page.getByRole("gridcell",{name:/^Grace Groomer, Wednesday/}).click();
  await page.getByTestId("availability-mode-off").click();
  await page.getByTestId("availability-save").click();
  await expect(page.getByRole("gridcell",{name:/^Grace Groomer, Wednesday, Off\./})).toContainText("Off");
});

test("@smoke a closed day refuses a booking at that location",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openAvailability(page);
  await page.getByTestId("availability-tab-closed").click();
  await expect(page.getByTestId("availability-closed-grid")).toBeVisible();

  await showClosureMonth(page,tenant.anchor);
  const day=page.locator(`[data-availability-day="${tenant.anchor}"]`);
  await expect(day).toHaveAttribute("aria-checked","false");
  await day.click();
  await expect(day).toHaveAttribute("aria-checked","true");
  await expect(day).toContainText("Closed");
  await expect(page.locator("#toast")).toContainText("is closed on");

  // It survives a reload, which is the difference between a saved closure and an optimistic flip.
  await page.reload();
  await expect(page.getByTestId("availability-tabs")).toBeVisible();
  await page.getByTestId("availability-tab-closed").click();
  await showClosureMonth(page,tenant.anchor);
  await expect(page.locator(`[data-availability-day="${tenant.anchor}"]`)).toHaveAttribute("aria-checked","true");

  await page.getByTestId("nav-calendar").click();
  await bookAppointment(page,{
    customerId:tenant.customerId,petId:tenant.petId,employeeId:tenant.employeeId,
    startAt:`${tenant.anchor}T09:00`
  });
  await expect(page.locator("#booking-error")).toContainText("The salon is closed on");
  await expect(page.locator("#booking-error")).toContainText(tenant.anchor);
});

test("@smoke availability states which scope each tab changes",async({page,tenant,request})=>{
  const me=await request.get("/api/me");
  const locationName=(await me.json()).business.locationName as string;
  await login(page,tenant.ownerEmail);
  await openAvailability(page);

  // The tab bar names the scope over each group, and the tabs carry it in their accessible names.
  const tabs=page.getByTestId("availability-tabs");
  await expect(tabs).toContainText("Workspace · All locations");
  await expect(tabs).toContainText(`${locationName} only`);
  await expect(page.getByTestId("availability-tab-default")).toHaveAttribute("aria-label","Default working hours, workspace-wide");
  await expect(page.getByTestId("availability-tab-closed")).toHaveAttribute("aria-label",`Closed, ${locationName} only`);

  const strip=page.getByTestId("availability-scope-strip");
  await expect(strip).toContainText("Workspace-wide.");
  await expect(strip).toContainText("These hours follow each groomer to every Pawsh location.");

  // Arrowing along the bar must not activate anything: four tabs, four loads, for one pass.
  await page.getByTestId("availability-tab-default").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("availability-tab-week")).toBeFocused();
  await expect(page.getByTestId("availability-tab-default")).toHaveAttribute("aria-selected","true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("availability-tab-week")).toHaveAttribute("aria-selected","true");
  await expect(page.getByTestId("settings-placeholder")).toContainText("Default working hours apply to every week");
  await expect(strip).toContainText("Workspace-wide.");

  await page.getByTestId("availability-tab-closed").click();
  await expect(strip).toContainText(`${locationName} only.`);
  await expect(page.getByTestId("availability-closed-grid")).toBeVisible();
  await expect(page.locator(".availability-closed-rule")).toContainText(`A closed day turns down every booking at ${locationName}`);
});

// The template switch is a width decision, so the viewport is pinned rather than inherited: the
// same assertions then hold on the desktop project and on the emulated phones.
test.describe("availability at phone width",()=>{
  test.use({viewport:{width:390,height:844}});

  test("@mobile-core availability stacks per groomer and edits through the dialog",async({page,tenant},testInfo)=>{
    await login(page,tenant.ownerEmail);
    if (await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-settings").isHidden()) {
      await page.locator("#mobile-nav-toggle").click();
    }
    await openAvailability(page);

    // Seven columns of times do not fit, so the same data arrives as a per-groomer list.
    await expect(page.getByTestId("availability-stack")).toBeVisible();
    await expect(page.getByTestId("availability-grid")).toHaveCount(0);
    await expectNoDocumentOverflow(page,testInfo);

    const wednesday=page.getByRole("button",{name:/^Grace Groomer, Wednesday/});
    await expect(wednesday).toContainText("8:00–6:00 PM");
    // Every row is a real touch target rather than a shrunken grid cell.
    const box=await wednesday.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    await wednesday.click();
    await expect(page.locator("#modal-title")).toHaveText("Working hours");
    await page.getByTestId("availability-start").fill("11:00");
    await page.getByTestId("availability-end").fill("16:00");
    await page.locator('#modal-fields input[data-availability-day="4"]').check();
    await page.getByTestId("modal-submit").click();

    await expect(page.locator("#modal")).toBeHidden();
    await expect(page.locator("#toast")).toContainText("Grace Groomer's working hours saved.");
    await expect(page.getByRole("button",{name:/^Grace Groomer, Wednesday/})).toContainText("11:00–4:00 PM");
    await expect(page.getByRole("button",{name:/^Grace Groomer, Thursday/})).toContainText("11:00–4:00 PM");
    await expectNoDocumentOverflow(page,testInfo);
  });
});

test("@smoke availability hides the editors it cannot offer without Team permission",async({page,tenant,request})=>{
  const member=await createMember(request,`viewer+${tenant.runId}@pawsh-test.example`,["calendar.view","settings.manage"]);
  await login(page,member.email);
  await openAvailability(page);

  // Absent rather than disabled, matching how the rest of the app gates: the grid stops being a
  // grid, and nothing on it looks like a control that happens to be broken.
  const table=page.getByTestId("availability-grid");
  await expect(table).toBeVisible();
  await expect(table).not.toHaveAttribute("role","grid");
  await expect(page.getByRole("gridcell",{name:/Grace Groomer/})).toHaveCount(0);
  await expect(page.locator("#availability-panel")).toContainText("Changing working hours needs the Team permission.");

  await page.getByRole("cell",{name:/^Grace Groomer, Wednesday/}).click();
  await expect(page.getByTestId("availability-editor")).toHaveCount(0);

  // The closure switches stay live: this member does hold settings.manage.
  await page.getByTestId("availability-tab-closed").click();
  await expect(page.getByTestId("availability-closed-grid")).toBeVisible();
  await expect(page.locator("[data-availability-day]").last()).toHaveAttribute("role","switch");
});
