import { test, expect, login, createMember, password } from "./fixtures/tenant.js";
import { expectNoDocumentOverflow } from "./helpers/responsive.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Settings → Roles & permissions.
 *
 * These run against the REAL roles API, with no `page.route` anywhere in the file. The screen's
 * whole job is to write a permission set correctly, so asserting on a mocked request body would
 * only prove the browser sent what the mock expected; every write here is read back through
 * `GET /api/roles` instead.
 *
 * A fresh workspace arrives with the THREE BUILT-IN ROLES — Groomer, Receptionist and Manager —
 * because signup runs `provisionBusinessCatalog`, which seeds them from the domain's `builtInRoles`.
 * The owner still holds no role: ownership is `is_owner`, not a permission set. Specs that need a
 * role of their own create one under a name the three do not already take.
 *
 * IF A PERMISSION-COUNT ASSERTION IN THIS FILE PASSES WHEN YOU EXPECTED IT TO FAIL, RESTART THE
 * SERVER BEFORE BELIEVING IT. The catalog these counts come from is built from `@pawsh/domain`,
 * which resolves to `packages/domain/dist` — a build artifact. `npm run db:migrate` does not
 * rebuild it and neither does starting the server; only `pretypecheck` and `pretest` do. So a
 * server left running across a change to `packages/domain/src` goes on serving the OLD catalog
 * indefinitely, and an e2e run against it validates a build nobody is shipping.
 *
 * This is not hypothetical: `customers.credit_edit` graduating out of `unenforcedPermissions`
 * should have moved the two figures below from 24/54 to 25/53, and against a stale server the
 * outdated assertion passed. A passing count is only evidence once the server has been restarted
 * since the last change to `packages/domain`.
 *
 * A built-in role is a Pawsh system template. Its identity is fixed — rename and delete are
 * refused, with codes — but it is NOT permanently on: switching it off is the supported way to
 * retire one, and re-enabling restores the same canonical role.
 *
 * What is worth covering is what is easy to get quietly wrong:
 *   - a filter that matches a row inside a folded group, which would otherwise read as no results;
 *   - a save assembled from the rendered rows, which would drop every permission the filter hid
 *     and every one belonging to the OTHER sheet;
 *   - a master switched off zeroing its children instead of leaving them alone;
 *   - a master rendered twice ON ONE SHEET, as a master and again as an ordinary row, which is two
 *     switches for one key sitting where they can be seen disagreeing - as distinct from the two
 *     that are MEANT to appear on both sheets, which the invariant test spells out;
 *   - a master reachable from neither sheet, which silently freezes the group it gates;
 *   - a confirm dismissed leaving the switch flipped, because the click had already flipped it.
 */

interface Role { id:string; name:string; version:number; permissions:string[]; enabled:boolean }

async function createRole(
  api:APIRequestContext,name:string,permissions:string[]
):Promise<Role> {
  const created=await api.post("/api/roles",{ data:{ name } });
  expect(created.ok(),await created.text()).toBeTruthy();
  const role=await created.json() as Role;
  if(!permissions.length)return role;
  const patched=await api.patch(`/api/roles/${role.id}`,{ data:{ version:role.version,permissions } });
  expect(patched.ok(),await patched.text()).toBeTruthy();
  return await patched.json() as Role;
}

/** One of the three roles signup provisions, by its canonical name. */
async function findRole(api:APIRequestContext,name:string):Promise<Role> {
  const response=await api.get("/api/roles");
  expect(response.ok(),await response.text()).toBeTruthy();
  const { roles }=await response.json() as { roles:Role[] };
  const role=roles.find((candidate)=>candidate.name===name);
  expect(role,`no provisioned role named ${name}`).toBeTruthy();
  return role!;
}

/** A built-in role's PERMISSIONS are editable; only its name and its existence are not. */
async function setRolePermissions(
  api:APIRequestContext,role:Role,permissions:string[]
):Promise<Role> {
  const patched=await api.patch(`/api/roles/${role.id}`,{ data:{ version:role.version,permissions } });
  expect(patched.ok(),await patched.text()).toBeTruthy();
  return await patched.json() as Role;
}

async function readRole(api:APIRequestContext,id:string):Promise<Role> {
  const response=await api.get("/api/roles");
  expect(response.ok(),await response.text()).toBeTruthy();
  const { roles }=await response.json() as { roles:Role[] };
  return roles.find((role)=>role.id===id)!;
}

async function openRoles(page:Page):Promise<void> {
  // The rail collapses behind a toggle on a phone, so reach for it the way a person would.
  if(await page.locator("#mobile-nav-toggle").isVisible() && await page.getByTestId("nav-settings").isHidden()){
    await page.locator("#mobile-nav-toggle").click();
  }
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button",{ name:"Roles & permissions", exact:true }).click();
  await expect(page.getByTestId("roles-table")).toBeVisible();
}

function row(page:Page,name:string) {
  return page.locator(`[data-role-row][data-role-name="${name}"]`);
}

function group(page:Page,id:string) {
  return page.locator(`[data-role-group-panel="${id}"]`);
}

function master(page:Page,key:string) {
  return page.locator(`[data-role-master="${key}"]`);
}

/**
 * Unfold a group so its rows can be clicked.
 *
 * The Permissions sheet opens FOLDED - 78 rows over eleven groups is a page to scroll rather than
 * a list to read, so it opens as its headings and their counts. Access Control's 23 rows still fit
 * and still open expanded, which is why this is a no-op there rather than a special case.
 */
async function openGroup(page:Page,id:string) {
  const panel=group(page,id);
  if(await panel.evaluate((node)=>(node as HTMLDetailsElement).open))return panel;
  await panel.locator("summary").click();
  await expect(panel).toHaveJSProperty("open",true);
  return panel;
}

/** Every permission key the open sheet renders, ordinary rows and master switches alike. */
async function renderedKeys(page:Page):Promise<string[]> {
  return page.evaluate(()=>[...document.querySelectorAll<HTMLElement>(
    "#role-editor-body [data-role-permission],#role-editor-body [data-role-master]"
  )].map((input)=>input.dataset.rolePermission ?? input.dataset.roleMaster ?? ""));
}

test("@smoke a new workspace pins the Owner above the three roles it is provisioned with",async({ page,tenant })=>{
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  // Ownership is not a role and the server never returns one, so this row is synthesized. It has
  // no permission set to open, nothing to rename and no switch to throw.
  const owner=row(page,"Owner");
  await expect(owner).toBeVisible();
  await expect(owner.getByTestId("role-assigned")).toHaveText("1");
  await expect(owner.locator(".roles-full")).toHaveCount(2);
  await expect(owner.getByTestId("role-row-actions")).toHaveCount(0);
  await expect(owner.getByTestId("role-enabled")).toBeDisabled();
  await expect(owner.getByTestId("role-enabled")).toHaveAccessibleName("Enable Owner role");

  // Signup provisions these, so a salon that signed up today opens the same screen as one migrated
  // last year rather than an empty table it has to hand-build before it can invite anybody.
  await expect(page.getByTestId("role-row")).toHaveCount(4);
  for(const name of ["Groomer","Receptionist","Manager"]){
    await expect(row(page,name)).toContainText("Built-in");
    await expect(row(page,name).getByTestId("role-disabled-mark")).toHaveCount(0);
  }
  await expect(page.getByTestId("roles-tab-login-control")).toContainText("Login Control (only for web)");

  // An invitation names a role, and there are three to name from the moment the salon exists.
  await page.getByTestId("roles-invite").click();
  await expect(page.getByTestId("field-roleId")).toBeVisible();
  await expect(page.getByTestId("field-roleId").locator("option")).toHaveCount(3);
});

test("@smoke a role is created through the screen and stored",async({ page,request,tenant })=>{
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await page.getByTestId("role-add").click();
  await page.getByTestId("field-name").fill("Front desk");
  await page.getByTestId("field-description").fill("Phones and checkout.");
  await page.getByTestId("modal-submit").click();
  await expect(page.getByTestId("modal")).toBeHidden();

  const frontDesk=row(page,"Front desk");
  await expect(frontDesk).toContainText("Phones and checkout.");
  await expect(frontDesk.getByTestId("role-assigned")).toHaveText("0");

  // It exists on the server, not only on screen.
  const { roles }=await (await request.get("/api/roles")).json() as { roles:Role[] };
  expect(roles.map((role)=>role.name)).toContain("Front desk");
});

test("@smoke the People list names each person's role, their status, and who is only invited",async({ page,request,tenant })=>{
  // The provisioned Groomer, not a fresh one: that name is taken from the moment the salon exists.
  const role=await findRole(request,"Groomer");
  const member=await createMember(request,`groomer+${tenant.runId}@pawsh-test.example`,["calendar.view"]);
  const invited=await request.post("/api/members/invitations",{
    data:{ email:`newhire+${tenant.runId}@pawsh-test.example`, roleId:role.id }
  });
  expect(invited.ok(),await invited.text()).toBeTruthy();

  await login(page,tenant.ownerEmail);
  await openRoles(page);

  const owner=page.getByTestId("member-row").filter({ hasText:tenant.ownerEmail });
  await expect(owner.getByTestId("member-role")).toHaveText("Owner");
  await expect(owner.getByTestId("member-status")).toHaveText("Active");

  const accepted=page.getByTestId("member-row").filter({ hasText:member.email });
  await expect(accepted.getByTestId("member-role")).toHaveText(member.roleName);
  await expect(accepted.getByTestId("member-status")).toHaveText("Active");

  // A pending invitation is a person who cannot sign in yet, and the list says so rather than
  // leaving them out until they do.
  const pending=page.getByTestId("invitation-row");
  await expect(pending).toContainText(`newhire+${tenant.runId}@pawsh-test.example`);
  await expect(pending).toContainText("Groomer");
  await expect(pending).toContainText("Invitation pending");

  // Ownership is transferred from the Owner's own row, not from inside a permission editor.
  await owner.getByTestId("member-row-actions").click();
  await expect(owner.getByTestId("member-transfer")).toBeVisible();
});

test("Login Control is an honest placeholder rather than controls that do nothing",async({ page,tenant })=>{
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await page.getByTestId("roles-tab-login-control").click();
  const panel=page.getByTestId("roles-login-control");
  await expect(panel).toContainText("Not available yet");
  await expect(panel.locator("input,select,textarea")).toHaveCount(0);
  await expect(page.getByTestId("roles-table")).toHaveCount(0);

  // Arrow keys move along the tab strip; Enter commits. Focus alone must not swap the panel.
  await page.getByTestId("roles-tab-login-control").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("roles-tab-roles")).toBeFocused();
  await expect(page.getByTestId("roles-login-control")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("roles-table")).toBeVisible();
});

test("every permission is reachable, once per sheet, and only the mirrored masters sit on both",async({ page,request,tenant })=>{
  /**
   * THE STRONGEST GUARANTEE IN THIS FILE, and what it now proves.
   *
   * It used to prove "exactly once in the whole editor", by adding the two sheets' switch counts
   * and comparing the total to the catalog. That arithmetic no longer describes the screen:
   * `dashboard.view` and `reports.view` are DELIBERATELY on both sheets - a listed row of their own
   * Permissions group, and the master switch of an Access Control group - because the reference
   * names "Access Dashboard" and "Access Report" in both places and an owner should find either one
   * wherever they thought to look. A naive sum would now read 103 against a catalog of 101 and
   * would have to be loosened to a number, which proves nothing.
   *
   * So the assertion is about coverage and overlap instead, and it is strictly stronger:
   *   1. WITHIN one sheet, no key is rendered twice - two switches for one key, side by side,
   *      where they could be seen disagreeing, is still the bug this guards.
   *   2. The UNION of the two sheets is the whole catalog - no permission is unreachable. This is
   *      the half that caught `settings.manage`, `dashboard.view` and `reports.view` rendering
   *      nowhere at all once they became masters of Permissions-sheet groups.
   *   3. The OVERLAP is exactly the two mirrored masters and nothing else, so a third key drifting
   *      onto both sheets is a failure rather than something the union quietly absorbs.
   *
   * Both sheets read the same `editor.selected` and only one is open at a time, so the mirrored
   * pair cannot hold different values - which is why (3) is a safe thing to allow and (1) is not.
   */
  await createRole(request,"Front desk",[]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  // This sheet renders no master block: each of its masters is the listed row of the group it
  // masters, which is the only place an owner can reach it.
  await expect(page.getByTestId("role-masters")).toHaveCount(0);
  for(const key of ["settings.manage","dashboard.view","reports.view"]){
    await expect(page.locator(`[data-role-permission-row="${key}"]`)).toHaveCount(1);
  }
  // Report's one row IS its master, so the group renders as that single real switch - not as an
  // empty group with a heading and nothing under it. This role holds nothing, so the count reads
  // "Off" rather than a zero that would claim a row had been cleared.
  await expect(group(page,"report-access").getByTestId("role-permission-row")).toHaveCount(1);
  await expect(group(page,"report-access").getByTestId("role-group-count")).toHaveText("Off");
  // The retired groups are gone: Operations and Money folded into Appointment, and Reporting split
  // into the two mirrored groups above.
  for(const id of ["reporting","operations","money"])await expect(group(page,id)).toHaveCount(0);
  const permissionsSheet=await renderedKeys(page);
  await page.getByTestId("role-editor-cancel").click();

  await row(page,"Front desk").getByTestId("role-open-access").click();
  // Untouched: here one master gates several groups, so it stays a switch above all of them rather
  // than a row inside any one, and it is not repeated among their rows.
  await expect(master(page,"dashboard.view")).toHaveCount(1);
  await expect(master(page,"reports.view")).toHaveCount(1);
  await expect(page.locator('[data-role-permission-row="dashboard.view"]')).toHaveCount(0);
  await expect(page.locator('[data-role-permission-row="reports.view"]')).toHaveCount(0);
  const accessSheet=await renderedKeys(page);
  await page.getByTestId("role-editor-cancel").click();

  // 1. Once per sheet.
  expect(new Set(permissionsSheet).size).toBe(permissionsSheet.length);
  expect(new Set(accessSheet).size).toBe(accessSheet.length);

  // 2. Between them, the whole catalog and nothing invented.
  const catalog=await (await request.get("/api/permissions")).json() as { permissions:string[] };
  expect([...new Set([...permissionsSheet,...accessSheet])].sort())
    .toEqual([...catalog.permissions].sort());

  // 3. The overlap is the mirrored pair, exactly.
  expect(permissionsSheet.filter((key)=>accessSheet.includes(key)).sort())
    .toEqual(["dashboard.view","reports.view"]);
});

test("a group's own master is reachable, and live, on the sheet that group lives on",async({ page,request,tenant })=>{
  /**
   * THE TRAP THIS GUARDS, which the taxonomy walked straight into.
   *
   * `settings.manage` is the Setting group's master AND one of its listed rows. While the editor
   * stripped every master from every group's rows catalog-wide, and rendered its master switches on
   * the Access Control sheet only, `settings.manage` was reachable from NEITHER sheet. A new role
   * starts empty, so Setting rendered permanently off: 26 disabled switches, a count reading "Off",
   * forced shut, and no control anywhere in the product able to turn it back on. The roles table
   * counted the key in its Permissions total regardless, so the table advertised a switch its own
   * sheet could not reach. `dashboard.view` and `reports.view` had the same trap.
   */
  const role=await createRole(request,"Front desk",[]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  const setting=await openGroup(page,"setting");
  await expect(setting.getByTestId("role-group-count")).toHaveText("Off");

  // The master is an ordinary row of its own group - and it is LIVE precisely when the group it
  // gates is not, which is the whole point of it.
  const gate=page.locator('[data-role-permission-row="settings.manage"] input');
  const child=page.locator('[data-role-permission-row="team.manage"] input');
  await expect(gate).toBeEnabled();
  await expect(gate).not.toBeChecked();
  await expect(child).toBeDisabled();

  await gate.check();
  await expect(setting.getByTestId("role-group-count")).toHaveText("1 of 27");
  await expect(child).toBeEnabled();

  // Switching a master off folds the group it gates - but NOT when the group is where that master
  // lives, because folding it would hide the only switch that can undo this.
  await gate.uncheck();
  await expect(setting.getByTestId("role-group-count")).toHaveText("Off");
  await expect(setting).toHaveJSProperty("open",true);
  await expect(gate).toBeEnabled();

  await gate.check();
  await page.getByTestId("role-editor-save").click();
  await expect(page.getByTestId("role-editor")).toBeHidden();
  expect((await readRole(request,role.id)).permissions).toContain("settings.manage");
});

test("a group Pawsh has not built says so on its heading, folds itself away, and still moves",async({ page,request,tenant })=>{
  /**
   * 69 of the 101 keys gate nothing yet, and five whole groups are inert end to end. Repeating the
   * same badge and the same sentence down every row of Cash Drawer taught an owner to skim past a
   * warning - so a WHOLLY unbuilt group says it once, on its heading, and its rows carry nothing.
   *
   * The switches still move, and that is the point rather than an oversight: these keys ship early
   * precisely so a salon can record who should hold them BEFORE the feature lands. A group that is
   * unbuilt is therefore not the same thing as a group that is off, and the two are true at once -
   * Payroll is every-row-unbuilt AND folds shut whenever `reports.view` is down.
   */
  const role=await createRole(request,"Front desk",[]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);
  await row(page,"Front desk").getByTestId("role-open-permissions").click();

  const cash=group(page,"cash-drawer");
  // Said on the heading, which `<details>` renders open or shut - so a folded group still announces
  // it, which a note inside the fold could never do.
  await expect(cash.getByTestId("role-group-unenforced")).toHaveText("Not yet available in Pawsh");
  await expect(cash.getByTestId("role-group-count")).toHaveText("0 of 2");
  // A mixed group is NOT marked wholly unbuilt, however many of its rows are.
  await expect(group(page,"appointment").getByTestId("role-group-unenforced")).toHaveCount(0);

  await openGroup(page,"cash-drawer");
  await expect(cash.getByTestId("role-group-note")).toContainText("Pawsh has not built this yet.");
  await expect(cash.getByTestId("role-group-note")).toContainText("takes effect the day the feature ships");
  // The group speaks for every row, so no row repeats it.
  await expect(cash.locator(".pref-unenforced")).toHaveCount(1);
  const manage=page.locator('[data-role-permission-row="cash_drawer.manage"]');
  await expect(manage.locator(".pref-unenforced")).toHaveCount(0);
  // ...and each row points at the one note instead, which is inside the same fold it is.
  await expect(manage.locator("input")).toHaveAttribute("aria-describedby","role-note-cash-drawer");

  // Operable, and never `aria-disabled`: saying "not built" must not read as "not yours to set".
  const toggle=manage.locator("input");
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toHaveAttribute("aria-disabled","true");
  await toggle.check();
  await expect(cash.getByTestId("role-group-count")).toHaveText("1 of 2");

  await page.getByTestId("role-editor-save").click();
  await expect(page.getByTestId("role-editor")).toBeHidden();
  expect((await readRole(request,role.id)).permissions).toContain("cash_drawer.manage");
});

test("a mixed group marks its own rows, and narrowing the sheet puts every badge back",async({ page,request,tenant })=>{
  // The note speaks for a whole group, so it is only truthful while the whole group is on screen.
  // A filter shows rows out of their group, so the note stands down and the per-row badge returns -
  // a match must never arrive unmarked.
  await createRole(request,"Front desk",[]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);
  await row(page,"Front desk").getByTestId("role-open-permissions").click();

  const appointment=await openGroup(page,"appointment");
  await expect(appointment.getByTestId("role-group-note"))
    .toContainText("8 of these 20 are marked");
  // Marked per row here, because only some of them are.
  await expect(page.locator('[data-role-permission-row="appointments.view_all_staff"] .pref-unenforced'))
    .toHaveCount(1);
  await expect(page.locator('[data-role-permission-row="calendar.view"] .pref-unenforced'))
    .toHaveCount(0);

  // Filter down to a row from a WHOLLY unbuilt group: its group note is gone, so the badge is back.
  await page.getByTestId("role-filter").fill("cash drawer");
  await expect(page.getByTestId("role-group-note")).toHaveCount(0);
  const drawer=page.locator('[data-role-permission-row="cash_drawer.manage"]');
  await expect(drawer.locator(".pref-unenforced")).toHaveCount(1);
  await expect(drawer.locator("input")).not.toHaveAttribute("aria-describedby",/./);
});

test("hiding what Pawsh has not built names the groups that went, and keeps their values",async({ page,request,tenant })=>{
  // Hiding must not make a group DISAPPEAR without saying so - an owner would conclude the taxonomy
  // has no Cash Drawer at all, and that what the role was set to for it had been discarded.
  const role=await createRole(request,"Front desk",["cash_drawer.manage","calendar.view"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);
  await row(page,"Front desk").getByTestId("role-open-permissions").click();

  const hide=page.getByTestId("role-hide-unbuilt");
  await expect(hide).not.toBeChecked();   // off on arrival, always
  await hide.check();

  // 53, not 55. Two keys have graduated out of `unenforcedPermissions` since the taxonomy landed,
  // and each one moves BOTH figures by one in opposite directions: `settings.discounts` the day
  // Settings -> Coupons & discounts became a real route family, and `customers.credit_edit` the
  // day client credit became a real ledger and that key alone started gating the creation of money
  // the salon owes. The total of 78 never moves - nothing was added, a switch changed sides.
  //
  // These two figures are read from a BUILD of `packages/domain`. If they pass when you expected
  // them to fail, restart the server first - see the note at the top of this file.
  await expect(page.getByTestId("role-filter-count")).toContainText("25 of 78 permissions");
  await expect(page.getByTestId("role-filter-count")).toContainText("53 not built yet, hidden");
  // The wholly unbuilt groups are gone from the sheet - and named underneath it.
  await expect(group(page,"cash-drawer")).toHaveCount(0);
  const note=page.getByTestId("role-hidden-note");
  await expect(note).toContainText("Cash Drawer");
  await expect(note).toContainText("Message/Call");
  await expect(note).toContainText("still saved");
  // A mixed group stays, minus its unbuilt rows.
  await expect(page.locator('[data-role-permission-row="calendar.view"]')).toHaveCount(1);
  await expect(page.locator('[data-role-permission-row="appointments.view_all_staff"]')).toHaveCount(0);

  // Saving while they are off screen keeps them exactly as they were.
  await openGroup(page,"clients");
  await page.locator('[data-role-permission-row="customers.view"] input').check();
  await page.getByTestId("role-editor-save").click();
  await expect(page.getByTestId("role-editor")).toBeHidden();
  expect([...(await readRole(request,role.id)).permissions].sort())
    .toEqual(["calendar.view","cash_drawer.manage","customers.view"]);
});

test("the filter opens the groups it matched instead of reporting no results",async({ page,request,tenant })=>{
  await createRole(request,"Front desk",["calendar.view","customers.view","checkout.perform"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  await expect(page.getByTestId("role-editor")).toBeVisible();
  await expect(page.locator("#role-editor-title")).toHaveText("Front desk");

  // The status transitions moved into Appointment when Operations was absorbed. The group starts
  // FOLDED and is not folded by this test: at 78 rows the Permissions sheet opens as its headings,
  // so the case this test exists for - a match hiding inside a fold - is now the default state of
  // every group rather than something a test has to arrange.
  const appointment=group(page,"appointment");
  await expect(appointment).toHaveJSProperty("open",false);

  await page.getByTestId("role-filter").fill("check in");
  // The row was one fold away from reading as "no results". It has to be on screen.
  await expect(appointment).toHaveJSProperty("open",true);
  await expect(page.getByTestId("role-permission-row")).toHaveCount(1);
  await expect(page.getByTestId("role-permission-row")).toContainText("Check in pets");
  await expect(page.getByTestId("role-filter-count")).toContainText("1 of");

  await page.getByTestId("role-filter").fill("zzz");
  await expect(page.getByTestId("role-filter-count")).toContainText("No permission matches");
  await expect(page.getByTestId("role-editor-empty")).toBeVisible();
});

test("saving one sheet stores the role's whole permission set, not the rows on screen",async({ page,request,tenant })=>{
  // Deliberately spread across BOTH sheets, so a save from either that dropped the other half is
  // visible in what the server ends up holding. Seeded onto the provisioned Groomer, which also
  // shows that a built-in role's permissions are editable even though its name is not.
  const role=await setRolePermissions(request,await findRole(request,"Groomer"),
    ["dashboard.view","dashboard.summary","calendar.view","operations.check_in"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Groomer").getByTestId("role-open-permissions").click();
  await expect(page.locator("#role-editor-dirty")).toHaveText("No changes");

  // Filter down to one row and grant it. Everything the filter hid — and the whole Access Control
  // half of this role, which this sheet cannot even show — has to survive the save.
  // "checkout" now reaches three rows, not one: `checkout.perform` and `checkout.split_tips` by
  // key, and `settings.discounts` through its HINT, which mentions applying a discount at checkout.
  // That is the filter working as designed - it searches label, hint and key - so the row is named
  // rather than assumed to be the only thing on screen.
  await page.getByTestId("role-filter").fill("checkout");
  await expect(page.getByTestId("role-permission-row")).toHaveCount(3);
  await page.locator('[data-role-permission-row="checkout.perform"] input').check();
  await expect(page.locator("#role-editor-dirty")).toHaveText("1 change not saved");

  await page.getByTestId("role-editor-save").click();
  await expect(page.getByTestId("role-editor")).toBeHidden();

  const stored=await readRole(request,role.id);
  expect([...stored.permissions].sort()).toEqual(
    ["calendar.view","checkout.perform","dashboard.summary","dashboard.view","operations.check_in"]);
  expect(stored.version).toBe(role.version+1);
});

test("a master switched off dims its rows and keeps their values",async({ page,request,tenant })=>{
  const role=await createRole(request,"Analyst",["dashboard.view","dashboard.summary"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Analyst").getByTestId("role-open-access").click();
  await expect(page.locator("#role-editor-eyebrow")).toHaveText("Access Control");

  const dashboard=group(page,"dashboard");
  await expect(dashboard.getByTestId("role-group-count")).toHaveText("1 of 8");
  await expect(dashboard.getByTestId("role-permission-row").filter({ hasText:"Summary" })
    .locator("input")).toBeChecked();

  // Payroll rides the other master, which this role does not hold, so it says so in words rather
  // than as a zero that would claim its rows had been cleared.
  await expect(group(page,"payroll").getByTestId("role-group-count")).toHaveText("Off");
  // Shipped ahead of the feature it gates. The row says so instead of implying it restricts
  // something today.
  await expect(dashboard.getByTestId("role-permission-row").filter({ hasText:"Commission" }))
    .toContainText("Not yet available in Pawsh");

  await master(page,"dashboard.view").uncheck();
  await expect(dashboard.getByTestId("role-group-count")).toHaveText("Off");
  await expect(dashboard).toHaveJSProperty("open",false);

  // The values are still the role's, and switching the master back on has to prove it.
  await master(page,"dashboard.view").check();
  await expect(dashboard.getByTestId("role-group-count")).toHaveText("1 of 8");
  await expect(dashboard.getByTestId("role-permission-row").filter({ hasText:"Summary" })
    .locator("input")).toBeChecked();

  // Off, then saved: the children keep their keys. Zeroing them here would silently revoke
  // permissions the operator only meant to stop applying.
  await master(page,"dashboard.view").uncheck();
  await page.getByTestId("role-editor-save").click();
  await expect(page.getByTestId("role-editor")).toBeHidden();

  const stored=await readRole(request,role.id);
  expect(stored.permissions).not.toContain("dashboard.view");
  expect(stored.permissions).toContain("dashboard.summary");
});

test("turning a role off names what the people holding it lose, and dismissing puts the switch back",async({ page,request,tenant })=>{
  const member=await createMember(request,`desk+${tenant.runId}@pawsh-test.example`,
    ["calendar.view","customers.view","checkout.perform"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  const role=row(page,member.roleName);
  await expect(role.getByTestId("role-assigned")).toHaveText("1");
  await role.getByTestId("role-enabled").uncheck();

  const impact=page.getByTestId("role-disable-impact");
  await expect(impact).toContainText("One person has");
  // The salon's own words, not "loses 12 permissions". Named as a LIST after a colon, so each label
  // keeps the exact casing of the switch the owner saw in the editor: the taxonomy's labels are
  // verbatim from the reference and mixed-case by design, and the sentence that used to lowercase
  // their first character rendered "access Clients Tab" and "check Out Appointments".
  await expect(impact).toContainText("They will lose: View calendar, Access Clients Tab, Check Out Appointments.");

  await page.getByTestId("stacked-dialog-dismiss").click();
  // The click already flipped it. Dismissing has to put it back.
  await expect(role.getByTestId("role-enabled")).toBeChecked();
  expect((await readRole(request,member.roleId)).enabled).toBe(true);

  await role.getByTestId("role-enabled").uncheck();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(role.getByTestId("role-enabled")).not.toBeChecked();
  expect((await readRole(request,member.roleId)).enabled).toBe(false);
});

test("a role saved by somebody else refuses to overwrite them",async({ page,request,tenant })=>{
  const role=await createRole(request,"Front desk",["calendar.view"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  // Money was absorbed into Appointment. The group has to be unfolded before a row can be clicked.
  await (await openGroup(page,"appointment")).getByTestId("role-permission-row").first()
    .locator("input").check();

  // Somebody else saves the same role while this drawer is open. The version the drawer captured is
  // now stale, and the server refuses rather than taking the last write.
  const concurrent=await request.patch(`/api/roles/${role.id}`,{
    data:{ version:role.version, permissions:["calendar.view","pets.view"] }
  });
  expect(concurrent.ok(),await concurrent.text()).toBeTruthy();

  await page.getByTestId("role-editor-save").click();
  const conflict=page.getByTestId("role-editor-conflict");
  await expect(conflict).toContainText("Somebody else changed this role");
  await expect(conflict).toContainText("not kept");
  await expect(page.getByTestId("role-editor-save")).toBeDisabled();

  // The other write stands, untouched.
  expect([...(await readRole(request,role.id)).permissions].sort()).toEqual(["calendar.view","pets.view"]);

  await page.getByTestId("role-editor-reload").click();
  await expect(page.getByTestId("role-editor-conflict")).toHaveCount(0);
  await expect(page.locator("#role-editor-dirty")).toHaveText("No changes");
});

test("transferring ownership makes the outgoing owner choose what they keep",async({ page,request,tenant })=>{
  const member=await createMember(request,`successor+${tenant.runId}@pawsh-test.example`,["calendar.view"]);
  await createRole(request,"Retired owner",["calendar.view","customers.view"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  const owner=page.getByTestId("member-row").filter({ hasText:tenant.ownerEmail });
  await owner.getByTestId("member-row-actions").click();
  await owner.getByTestId("member-transfer").click();

  await page.getByTestId("ownership-candidates").getByText(member.email,{ exact:false }).first().click();
  await page.getByTestId("stacked-dialog-confirm").click();

  // Ownership is not a role, so it cannot be handed over with it: the outgoing owner has to land
  // somewhere, and the server refuses the transfer without a role named for them.
  const outgoing=page.getByTestId("ownership-outgoing-roles");
  await expect(outgoing).toBeVisible();
  await expect(outgoing).toContainText("Retired owner");
  // Same builder as the disable-impact sentence, same list form, same verbatim casing.
  await expect(outgoing).toContainText("Lets you: View calendar, Access Clients Tab.");
  await expect(page.getByTestId("ownership-consequence")).toContainText("stops being the Owner");

  await outgoing.getByText("Retired owner").click();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(page.locator("#toast")).toContainText("is now the owner");

  const me=await (await request.get("/api/me")).json() as
    { isOwner:boolean; role:{ name:string }|null };
  expect(me.isOwner).toBe(false);
  expect(me.role?.name).toBe("Retired owner");
});

test("a manager reads this screen and does not edit it",async({ page,request,tenant })=>{
  await createRole(request,"Front desk",["calendar.view"]);
  const manager=await createMember(request,`manager+${tenant.runId}@pawsh-test.example`,
    ["team.manage","settings.manage","calendar.view","dashboard.view"]);

  await login(page,manager.email,password);
  await openRoles(page);

  // Every role write is Owner-only on the server, so the controls are absent rather than present
  // and answering 403.
  await expect(page.getByTestId("role-add")).toHaveCount(0);
  await expect(page.getByTestId("roles-invite")).toHaveCount(0);
  await expect(page.getByTestId("role-row-actions")).toHaveCount(0);
  await expect(page.getByTestId("member-row-actions")).toHaveCount(0);
  await expect(page.getByTestId("invitation-cancel")).toHaveCount(0);

  // NOT ONE live switch anywhere in the table - the built-in rows included, which are the ones an
  // owner may now throw. A control that is present and answers 403 is worse than one that is not.
  const switches=page.getByTestId("role-enabled");
  await expect(switches).toHaveCount(await page.getByTestId("role-row").count());
  for(let index=0;index<await switches.count();index++)await expect(switches.nth(index)).toBeDisabled();
  await expect(row(page,"Groomer").getByTestId("role-enabled"))
    .toHaveAttribute("title","Only an Owner can turn a role on or off.");

  // Reading what a role grants is still their job, so the editor opens — without a Save, and with
  // nothing inside it that writes.
  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  await expect(page.getByTestId("role-editor-readonly")).toContainText("Only an Owner can change");
  await expect(page.getByTestId("role-editor-save")).toBeHidden();
  // Every switch on the sheet, folded groups included - `toBeDisabled` reads the control, not its
  // visibility. The count is taken once: this is 78 rows now, not the 22 it was written against.
  const rows=page.getByTestId("role-permission-row").locator("input");
  const total=await rows.count();
  expect(total).toBeGreaterThan(70);
  for(let index=0;index<total;index++)await expect(rows.nth(index)).toBeDisabled();
  await expect(page.locator("[data-role-bulk]").first()).toBeDisabled();
});

test("approving an access request names the role it grants",async({ page,request,tenant })=>{
  await createRole(request,"Front desk",["calendar.view","customers.view"]);
  const requester=`applicant+${tenant.runId}@pawsh-test.example`;
  const raised=await request.post("/api/workspace-access-requests",{ data:{
    requesterName:"Dana Applicant", requesterEmail:requester,
    workspaceName:`PW Smoke ${tenant.runId}`, workspaceAdminEmail:tenant.ownerEmail
  }});
  expect(raised.ok(),await raised.text()).toBeTruthy();

  await login(page,tenant.ownerEmail);
  await openRoles(page);

  const pending=page.getByTestId("access-request-row");
  await expect(pending).toContainText("Dana Applicant");
  await pending.getByTestId("access-request-approve").click();

  // The old flow granted the Groomer preset silently. Approving now says what it hands over.
  const picker=page.getByTestId("access-request-roles");
  await expect(picker).toContainText("Front desk");
  await picker.getByText("Front desk").click();
  await page.getByTestId("stacked-dialog-confirm").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();

  await expect(page.getByTestId("roles-access-requests")).toContainText("No pending requests");
  const invitations=await (await request.get("/api/members/invitations")).json() as
    { invitations:Array<{ email:string; role:{ name:string }|null }> };
  expect(invitations.invitations.find((invitation)=>invitation.email===requester)?.role?.name)
    .toBe("Front desk");
});

test("a built-in role keeps its identity but can be retired and brought back",async({ page,request,tenant })=>{
  // A built-in role is a Pawsh system template. Its NAME is its identity, so rename and delete are
  // refused - with codes, server-side - but it is not permanently on: switching it off is the
  // supported way to retire one the salon does not use.
  await login(page,tenant.ownerEmail);
  await openRoles(page);

  const groomer=row(page,"Groomer");
  await expect(groomer).toContainText("Built-in");

  // Omitted from the menu, not offered and disabled: a disabled item invites somebody to hunt for
  // the permission that would enable it, and there is none. Duplicating is how a salon gets a role
  // of its own that starts from this one.
  await groomer.getByTestId("role-row-actions").click();
  await expect(groomer.getByTestId("role-duplicate")).toBeVisible();
  await expect(groomer.getByTestId("role-rename")).toHaveCount(0);
  await expect(groomer.getByTestId("role-delete")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(groomer.getByTestId("role-row-actions")).toHaveAttribute("aria-expanded","false");

  // The switch is live for an owner, and names its own role rather than relying on the column head.
  const enable=groomer.getByTestId("role-enabled");
  await expect(enable).toBeEnabled();
  await expect(enable).toHaveAccessibleName("Enable Groomer role");
  await expect(enable).toBeChecked();

  const before=await findRole(request,"Groomer");
  await enable.uncheck();
  // Nobody holds it, so retiring it is not a decision about anybody and needs no confirmation.
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(enable).not.toBeChecked();
  // Off has to read as off in words, not only as the shape and colour of a switch.
  await expect(groomer.getByTestId("role-disabled-mark")).toHaveText("Disabled");
  expect((await findRole(request,"Groomer")).enabled).toBe(false);

  await enable.check();
  await expect(groomer.getByTestId("role-disabled-mark")).toHaveCount(0);

  // The same canonical role came back, not a copy: same id, same name, same grants.
  const after=await findRole(request,"Groomer");
  expect(after.enabled).toBe(true);
  expect(after.id).toBe(before.id);
  expect(after.name).toBe("Groomer");
  expect([...after.permissions].sort()).toEqual([...before.permissions].sort());
});

test("the server refuses to rename or delete a built-in role",async({ request,tenant })=>{
  // Unreachable through the UI, which omits both. These are the codes a stale page would meet, and
  // they are asserted here so the frontend's handling of them is written against something real.
  // The `tenant` fixture is what signs the shared `request` context into this workspace.
  expect(tenant.businessId).toBeTruthy();
  const groomer=await findRole(request,"Groomer");
  const renamed=await request.patch(`/api/roles/${groomer.id}`,{
    data:{ version:groomer.version, name:"Bather" }
  });
  expect(renamed.status()).toBe(409);
  expect((await renamed.json() as { code:string }).code).toBe("ROLE_BUILT_IN_NAME_IMMUTABLE");

  const deleted=await request.delete(`/api/roles/${groomer.id}`);
  expect(deleted.status()).toBe(409);
  expect((await deleted.json() as { code:string }).code).toBe("ROLE_BUILT_IN_UNDELETABLE");

  // Refused, and still exactly as it was.
  expect((await findRole(request,"Groomer")).name).toBe("Groomer");
});

test("@responsive the roles workspace and its editor fit a phone",async({ page,request,tenant },testInfo)=>{
  await createRole(request,"Front desk",["calendar.view"]);
  await login(page,tenant.ownerEmail);
  await openRoles(page);
  await expectNoDocumentOverflow(page,testInfo);

  await row(page,"Front desk").getByTestId("role-open-permissions").click();
  await expect(page.getByTestId("role-editor")).toBeVisible();
  await expectNoDocumentOverflow(page,testInfo);
});
