import { createMember, test, expect, login } from "./fixtures/tenant.js";
import { expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Settings → Staff.
 *
 * The screen replaced a second staff editor that sent `{displayName}` alone to a full-replace
 * PUT, so a rename cleared the account link and every service restriction. These cover that
 * regression from the UI, the two controls that write on their own — Active and Available
 * services — and the three things the pane asserts about a person: their colour, whether their
 * account is linked, and what they can be booked for.
 */

interface Employee {
  id: string;
  displayName: string;
  active: boolean;
  colorSlot: number | null;
  membershipId: string | null;
  serviceIds: string[];
}

async function openStaff(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button",{name:"Staff",exact:true}).click();
  await expect(page.getByTestId("staff-detail")).toBeVisible();
}

async function roster(api: APIRequestContext): Promise<Employee[]> {
  return (await api.get("/api/employees")).json() as Promise<Employee[]>;
}

function card(page: Page,name: string) {
  return page.getByTestId("staff-card").filter({hasText:name});
}
// The radio itself is a 1px clipped input under its own dot, which is exactly how a native radio
// group buys arrow-key roving and single-tab-stop for free. Drive it the way a person does.
function swatch(page: Page,name: string) {
  if(name==="Automatic")return page.locator(".staff-swatch.is-auto");
  // Not `hasText`: the Automatic cell names the colour it currently resolves to, so it contains
  // every other swatch's word.
  return page.locator(".staff-swatch:not(.is-auto)").filter({hasText:new RegExp(`^${name}$`)});
}

test("@smoke the roster lists every groomer and a card swaps the record beside it",async({page,request,tenant})=>{
  await request.post("/api/employees",{data:{displayName:"Alex Groomer"}});
  await login(page,tenant.ownerEmail);
  await openStaff(page);

  await expect(page.getByTestId("staff-card")).toHaveCount(2);
  // Alphabetical within active, so Alex leads and is auto-selected.
  await expect(page.getByTestId("staff-detail").getByRole("heading",{level:3})).toHaveText("Alex Groomer");
  await expect(page.getByTestId("staff-name")).toHaveValue("Alex Groomer");
  await expect(page.locator(".staff-rail-count")).toHaveText("2 staff");

  await card(page,"Grace Groomer").click();
  await expect(page.getByTestId("staff-detail").getByRole("heading",{level:3})).toHaveText("Grace Groomer");
  await expect(page.getByTestId("staff-name")).toHaveValue("Grace Groomer");
  await expect(card(page,"Grace Groomer")).toHaveAttribute("aria-selected","true");
  await expect(card(page,"Alex Groomer")).toHaveAttribute("aria-selected","false");
  // Grace is restricted to the two fixture services, and the summary says so in a sentence.
  await expect(page.getByTestId("staff-services-summary")).toContainText("Only these can be booked");
  await expect(page.getByTestId("staff-detail").locator(".staff-chip.is-restricted")).toBeVisible();
});

// The regression this screen exists for. The old editor sent the name alone to a route that read
// an absent membershipId as null and defaulted serviceIds to [], so renaming a groomer detached
// them from their own work history and deleted every service they were set up for.
test("renaming a groomer keeps their linked account and their service restriction",async({page,request,tenant})=>{
  const member=await createMember(request,`linked+${tenant.runId}@pawsh-test.example`,["calendar.view"]);
  expect((await request.put(`/api/employees/${tenant.employeeId}`,{
    data:{membershipId:member.membershipId}
  })).status()).toBe(200);

  await login(page,tenant.ownerEmail);
  await openStaff(page);
  await card(page,"Grace Groomer").click();
  await expect(page.getByTestId("staff-membership")).toHaveValue(member.membershipId);
  await expect(page.getByTestId("staff-detail").locator(".staff-detail-role")).toContainText(member.email);

  await expect(page.getByTestId("staff-save")).toBeDisabled();
  await page.getByTestId("staff-name").fill("Grace Groomer-Hale");
  await expect(page.getByTestId("staff-save")).toBeEnabled();
  await page.getByTestId("staff-save").click();
  await expect(card(page,"Grace Groomer-Hale")).toBeVisible();

  const grace=(await roster(request)).find(employee=>employee.id===tenant.employeeId);
  expect(grace?.displayName).toBe("Grace Groomer-Hale");
  expect(grace?.membershipId).toBe(member.membershipId);
  expect(grace?.serviceIds).toHaveLength(2);
});

test("a chosen colour reaches the calendar and Automatic hands it back to the hash",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openStaff(page);
  await card(page,"Grace Groomer").click();
  await expect(page.getByTestId("staff-colour-current")).toContainText("Selected: Automatic");

  // Plum is slot 5, which the hash can never produce: its modulus stays at five so no existing
  // calendar changes colour, and 5-9 are reachable only by choosing them here.
  await swatch(page,"Plum").click();
  await expect(page.getByTestId("staff-colour-current")).toHaveText("Selected: Plum");
  await page.getByTestId("staff-save").click();
  await expect(card(page,"Grace Groomer")).toHaveAttribute("data-groomer-slot","5");
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.colorSlot).toBe(5);

  await page.getByTestId("nav-calendar").click();
  await expect(page.locator('.week-groomer-head[title="Grace Groomer"]').first())
    .toHaveAttribute("data-groomer-slot","5");

  await openStaff(page);
  await card(page,"Grace Groomer").click();
  await swatch(page,"Automatic").click();
  await expect(page.getByTestId("staff-colour-current")).toContainText("Selected: Automatic (");
  await page.getByTestId("staff-save").click();
  // Back on the hash, which only ever returns 0-4.
  await expect(card(page,"Grace Groomer")).toHaveAttribute("data-groomer-slot",/^[0-4]$/);
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.colorSlot).toBeNull();
});

test("the services drawer refuses a restriction with nothing in it, and clearing one is allowed",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openStaff(page);
  await card(page,"Grace Groomer").click();
  await page.getByTestId("staff-services-edit").click();

  const drawer=page.getByTestId("staff-services-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("radio",{name:/Restrict to selected services/})).toBeChecked();
  await drawer.getByRole("checkbox",{name:"Full Groom",exact:true}).uncheck();
  await drawer.getByRole("checkbox",{name:"Nail Trim",exact:true}).uncheck();
  // Saving an empty restriction would silently mean "unrestricted", so it is refused outright.
  await expect(drawer.getByTestId("staff-services-refusal"))
    .toHaveText("Choose at least one service, or switch to No restriction.");
  await expect(drawer.getByTestId("staff-services-save")).toBeDisabled();

  await drawer.getByRole("radio",{name:/No restriction/}).check();
  await expect(drawer.getByTestId("staff-services-save")).toBeEnabled();
  await drawer.getByTestId("staff-services-save").click();
  await expect(drawer).toBeHidden();

  await expect(page.getByTestId("staff-services-summary")).toContainText("All services.");
  await expect(page.getByTestId("staff-detail").locator(".staff-chip.is-restricted")).toHaveCount(0);
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.serviceIds).toEqual([]);
});

test("the four unbuilt capabilities are grouped, closed, and genuinely inert",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openStaff(page);

  const group=page.getByTestId("staff-unavailable");
  await expect(group).toBeVisible();
  await expect(group).not.toHaveAttribute("open","");
  await expect(group.getByRole("group")).toBeHidden();

  await group.locator("summary").click();
  await expect(group.getByText("Enable online booking")).toBeVisible();
  const controls=group.locator("fieldset input, fieldset button");
  await expect(controls).toHaveCount(4);
  for (let index=0; index<4; index+=1) await expect(controls.nth(index)).toBeDisabled();

  // A native disabled fieldset takes its contents out of the tab order rather than leaving a
  // focusable control that does nothing, so nothing inside it can be reached from the summary.
  await group.locator("summary").focus();
  await page.keyboard.press("Tab");
  expect(await group.locator("fieldset :focus").count()).toBe(0);
});

test("a session without Team sees the record as facts and never the linked email",async({page,request,tenant})=>{
  const member=await createMember(request,`linked+${tenant.runId}@pawsh-test.example`,["calendar.view"]);
  await request.put(`/api/employees/${tenant.employeeId}`,{data:{membershipId:member.membershipId}});
  const viewer=await createMember(request,`viewer+${tenant.runId}@pawsh-test.example`,
    ["calendar.view","settings.manage"]);

  await login(page,viewer.email);
  await openStaff(page);

  // The rail still renders - the calendar needs these names - but nothing on the pane writes.
  await expect(page.getByTestId("staff-card")).toHaveCount(1);
  await expect(page.getByTestId("staff-add")).toHaveCount(0);
  await expect(page.getByTestId("staff-form")).toHaveCount(0);
  await expect(page.getByTestId("staff-active")).toHaveCount(0);
  await expect(page.getByTestId("staff-services-edit")).toHaveCount(0);
  await expect(page.getByTestId("staff-unavailable")).toHaveCount(0);
  await expect(page.locator(".staff-permission-note")).toHaveText("Editing staff needs the Team permission.");

  const detail=page.getByTestId("staff-detail");
  await expect(detail.locator(".account-facts")).toContainText("Linked to a workspace account");
  await expect(detail).not.toContainText(member.email);
  // phone is withheld from this session entirely, so the pane does not claim it is unrecorded.
  await expect(detail.locator(".account-facts")).not.toContainText("Phone");
});

test("the roster is one tab stop with manual activation, and the swatches are one radio group",async({page,request,tenant})=>{
  await request.post("/api/employees",{data:{displayName:"Alex Groomer"}});
  await login(page,tenant.ownerEmail);
  await openStaff(page);

  await card(page,"Alex Groomer").focus();
  await expect(card(page,"Alex Groomer")).toHaveAttribute("tabindex","0");
  await expect(card(page,"Grace Groomer")).toHaveAttribute("tabindex","-1");

  // Arrow moves focus and nothing else: the panel holds a form, and arrowing past a half-typed
  // record must not tear it down.
  await page.keyboard.press("ArrowDown");
  await expect(card(page,"Grace Groomer")).toBeFocused();
  await expect(page.getByTestId("staff-detail").getByRole("heading",{level:3})).toHaveText("Alex Groomer");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("staff-detail").getByRole("heading",{level:3})).toHaveText("Grace Groomer");

  await swatch(page,"Violet").click();
  await expect(page.getByTestId("staff-colour-current")).toHaveText("Selected: Violet");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio",{name:"Steel blue",exact:true})).toBeChecked();
  await expect(page.getByTestId("staff-colour-current")).toHaveText("Selected: Steel blue");
});

test("Active deactivates through a confirmation and reactivates in place",async({page,request,tenant})=>{
  await request.post("/api/employees",{data:{displayName:"Alex Groomer"}});
  await login(page,tenant.ownerEmail);
  await openStaff(page);
  await card(page,"Grace Groomer").click();

  await page.getByTestId("staff-active").uncheck();
  await expect(page.getByTestId("stacked-dialog-confirm")).toBeVisible();
  await page.getByTestId("stacked-dialog-dismiss").click();
  // Cancelled: the switch never sits in a state the server did not accept.
  await expect(page.getByTestId("staff-active")).toBeChecked();
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.active).toBe(true);

  await page.getByTestId("staff-active").uncheck();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("staff-active")).not.toBeChecked();
  await expect(card(page,"Grace Groomer")).toHaveClass(/is-inactive/);
  await expect(card(page,"Grace Groomer")).not.toHaveAttribute("data-groomer-slot",/./);
  await expect(page.locator(".staff-rail-count")).toHaveText("2 staff · 1 inactive");
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.active).toBe(false);

  // Reactivation needs no confirmation.
  await page.getByTestId("staff-active").check();
  await expect(page.getByTestId("staff-active")).toBeChecked();
  await expect(page.locator(".staff-rail-count")).toHaveText("2 staff");
  expect((await roster(request)).find(employee=>employee.id===tenant.employeeId)?.active).toBe(true);
});

// Reachable in three steps: link an account, deactivate the person, revoke that account. Without
// the guard, reactivating would hand a revoked login back its attribution on report cards,
// agreements, rabies verifications, photos and notes.
test("a refused reactivation explains itself in the row and offers the unlink that fixes it",async({page,request,tenant})=>{
  const member=await createMember(request,`revoked+${tenant.runId}@pawsh-test.example`,["calendar.view"]);
  await request.put(`/api/employees/${tenant.employeeId}`,{data:{membershipId:member.membershipId}});
  expect((await request.delete(`/api/employees/${tenant.employeeId}`)).status()).toBe(204);
  expect((await request.delete(`/api/members/${member.membershipId}`)).status()).toBeLessThan(300);

  await login(page,tenant.ownerEmail);
  await openStaff(page);
  await card(page,"Grace Groomer").click();
  await page.getByTestId("staff-active").check();

  const refusal=page.getByTestId("staff-active-refusal");
  await expect(refusal).toContainText("workspace access was revoked");
  await expect(refusal).toContainText(member.email);
  await expect(page.getByTestId("staff-active")).not.toBeChecked();
  // Unlinking is the remedy the message names, and it stays reachable without leaving the pane.
  await expect(page.getByTestId("staff-membership")).toBeEnabled();

  await refusal.getByTestId("staff-unlink-reactivate").click();
  await expect(page.getByTestId("staff-active")).toBeChecked();
  await expect(page.getByTestId("staff-active-refusal")).toHaveCount(0);
  const grace=(await roster(request)).find(employee=>employee.id===tenant.employeeId);
  expect(grace?.active).toBe(true);
  expect(grace?.membershipId).toBeNull();
});

test("Add staff creates the record from a draft row rather than a modal",async({page,request,tenant})=>{
  await login(page,tenant.ownerEmail);
  await openStaff(page);

  await page.getByTestId("staff-add").click();
  await expect(page.getByTestId("staff-name")).toBeFocused();
  await expect(page.getByTestId("staff-detail").getByRole("heading",{level:3})).toHaveText("New staff member");
  // A person who does not exist cannot be deactivated, and has nothing to be told is unbuilt.
  await expect(page.getByTestId("staff-active")).toHaveCount(0);
  await expect(page.getByTestId("staff-unavailable")).toHaveCount(0);

  await page.getByTestId("staff-name").fill("Priya Groomer");
  await page.getByTestId("staff-phone").fill("626-555-0199");
  await page.getByTestId("staff-save").click();
  await expect(card(page,"Priya Groomer")).toHaveAttribute("aria-selected","true");
  await expect(page.getByTestId("staff-phone")).toHaveValue("626-555-0199");
  expect((await roster(request)).map(employee=>employee.displayName)).toContain("Priya Groomer");
});

test("the roster sits beside the record on a wide screen and stacks above it on a narrow one",
  async({page,request,tenant},testInfo)=>{
    await request.post("/api/employees",{data:{displayName:"Alex Groomer"}});
    await login(page,tenant.ownerEmail);
    await page.setViewportSize({width:1280,height:900});
    await page.goto("/settings/staff");
    await expect(page.getByTestId("staff-detail")).toBeVisible();

    const beside=await page.locator(".staff-rail").boundingBox();
    const record=await page.getByTestId("staff-detail").boundingBox();
    expect(beside!.x+beside!.width).toBeLessThanOrEqual(record!.x+1);
    await expectNoDocumentOverflow(page,testInfo);

    // Below 760 the columns become rows, matching how the messages and client-profile workspaces
    // collapse, and activation moves focus into the panel so it cannot scroll away from the tab
    // that still holds it.
    await page.setViewportSize({width:640,height:900});
    const above=await page.locator(".staff-rail").boundingBox();
    const stacked=await page.getByTestId("staff-detail").boundingBox();
    expect(above!.y+above!.height).toBeLessThanOrEqual(stacked!.y+1);
    await expectNoDocumentOverflow(page,testInfo);

    await card(page,"Grace Groomer").click();
    await expect(page.getByTestId("staff-detail")).toBeFocused();
  });
