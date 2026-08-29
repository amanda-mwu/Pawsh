import { test, expect, login } from "../fixtures/tenant.js";

test("@smoke auth session lifecycle is usable and safe",async({page,tenant})=>{
  await page.goto("/");
  await page.getByRole("button",{name:/already have an account/i}).click();
  await page.getByTestId("login-email").fill(tenant.ownerEmail);
  await page.getByTestId("login-password").fill("wrong password");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByRole("alert")).toContainText("Invalid email or password");
  await page.getByTestId("login-password").fill(tenant.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("auth-form")).toBeVisible();
  const deniedStatus=await page.evaluate(async()=>{
    const response=await fetch("/api/me",{credentials:"include"});
    return response.status;
  });
  expect(deniedStatus).toBe(401);
  await page.getByRole("button",{name:/already have an account/i}).click();
  await page.getByTestId("login-email").fill(tenant.ownerEmail);
  await page.getByTestId("login-password").fill(tenant.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
});

test("@smoke business configuration persists through the GUI",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button",{name:"Business",exact:true}).click();await page.getByRole("button",{name:"Edit business settings"}).click();
  await page.getByTestId("field-name").fill(`QA Salon ${tenant.runId}`);
  await page.getByTestId("field-timezone").fill("America/Los_Angeles");
  await page.getByTestId("field-currency").fill("USD");
  await page.getByTestId("field-taxRate").fill("8.25");
  await page.locator('input[name="reminderHours"]').fill("24");
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#account-role")).toContainText(`QA Salon ${tenant.runId}`);
  await page.reload();
  await expect(page.locator("#account-role")).toContainText(`QA Salon ${tenant.runId}`);
});

test("@smoke account menu and personal profile remain separate from business settings",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  const trigger=page.getByTestId("account-trigger");
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded","true");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByRole("menuitem",{name:"Change password"})).toBeEnabled();
  await expect(page.getByRole("menuitem",{name:/Switch location/})).toBeDisabled();
  await expect(page.getByRole("menuitem",{name:/Invite a friend/})).toBeDisabled();
  await page.getByTestId("profile-account-link").click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId("profile-account-view")).toBeVisible();
  await expect(page.getByTestId("profile-email")).toHaveValue(tenant.ownerEmail);
  await expect(page.getByTestId("profile-email")).toHaveAttribute("readonly","");
  await expect(page.locator("#profile-workspace")).toContainText("PW Smoke");
  await expect(page.locator("#profile-role")).toHaveText("Owner");
  await expect(page.getByTestId("profile-account-view").getByText("Business hours")).toHaveCount(0);
  const displayName=`Callie ${tenant.runId.slice(-8)}`;
  await page.getByTestId("profile-display-name").fill(displayName);
  await page.getByRole("button",{name:"Save profile"}).click();
  await expect(trigger).toContainText(displayName);
  await page.reload();
  await expect(page.getByTestId("profile-account-view")).toBeVisible();
  await expect(page.getByTestId("profile-display-name")).toHaveValue(displayName);
  await trigger.click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("auth-form")).toBeVisible();
});

test("@smoke Pet options opens on Pet Type and reaches each type's breeds",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.goto("/settings/pet-options");
  // Pet Options is the pet-configuration workspace; Pet Type is its first section.
  const nav=page.locator(".pet-options-nav button");
  await expect(nav).toHaveCount(8);
  await expect(nav.nth(0)).toHaveText("Pet Type");
  await expect(nav.nth(0)).toHaveClass(/active/);
  const rows=page.locator("#pet-type-body tr[data-pet-type-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Dog");
  await expect(rows.nth(1)).toContainText("Cat");
  // Pet types are shared Pawsh taxonomy, so these are shown but not yet actionable.
  await expect(rows.nth(0).getByRole("button",{name:"Delete"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"+ Add"})).toBeDisabled();
  // Sections without a salon-configurable surface say so rather than being omitted.
  await nav.nth(1).click();
  await expect(page.getByTestId("settings-placeholder")).toContainText("Behavior");
  await nav.nth(0).click();
  // Breeds open over Pet Options in a drawer, scoped to that pet type. Cat breeds were
  // unreachable from the catalog before, though they were already selectable on a pet.
  await rows.nth(1).getByRole("button",{name:"Breeds"}).click();
  const drawer=page.getByTestId("breed-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.locator("#breed-drawer-title")).toHaveText("Breeds for Cat");
  const names=await page.locator("#breed-drawer-list li[data-breed-id] .breed-row-name").allInnerTexts();
  expect(names).toContain("Abyssinian");
  expect(names).not.toContain("Beagle");
  await expect(page.locator("#breed-add")).toBeEnabled();
  // Dismissable three ways, each returning to the Pet Type list.
  await page.getByTestId("breed-drawer-close").click();
  await expect(drawer).toBeHidden();
  await rows.nth(0).getByRole("button",{name:"Breeds"}).click();
  await expect(page.locator("#breed-drawer-title")).toHaveText("Breeds for Dog");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await rows.nth(0).getByRole("button",{name:"Breeds"}).click();
  await page.mouse.click(60,400);
  await expect(drawer).toBeHidden();
  await expect(page.locator("#pet-type-body")).toBeVisible();
});

test("@smoke breed management lives in Pet Options and overrides per business",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.goto("/settings/pet-options");
  // Salon no longer carries a competing catalog: one surface owns breeds.
  await page.getByTestId("nav-setup").click();
  await expect(page.locator("#setup").getByText("Breed Catalog")).toHaveCount(0);
  await page.locator("#setup .setup-menu summary").click();
  await expect(page.locator("#setup .setup-menu").getByRole("link",{name:"Breed catalog"})).toHaveCount(0);

  await page.goto("/settings/pet-options");
  const rows=page.locator("#pet-type-body tr[data-pet-type-row]");
  await rows.nth(0).getByRole("button",{name:"Breeds"}).click();
  await expect(page.locator("#breed-drawer-title")).toHaveText("Breeds for Dog");
  const list=page.locator("#breed-drawer-list li[data-breed-id]");
  await expect(list.first()).toBeVisible();
  expect(await list.count()).toBeGreaterThan(20);

  // Search narrows to one row, which is then the row every control below acts on.
  const first=list.first();
  const name=(await first.locator(".breed-row-name").innerText()).trim();
  await page.locator("#breed-drawer-search").fill(name);
  const row=page.locator(`#breed-drawer-list li[data-breed-id="${await first.getAttribute("data-breed-id")}"]`);
  await expect(row).toBeVisible();
  // A shared Pawsh breed is configurable but never renamable or deletable.
  await expect(row).not.toHaveAttribute("data-business-owned","true");
  await expect(row.locator(".breed-rename")).toHaveCount(0);
  await expect(row.locator(".breed-delete")).toHaveCount(0);
  await expect(row.locator(".breed-reset")).toHaveCount(0);

  // Pricing class is a per-business override. Pick a class the row is not already on so the
  // save is a real change whatever the Pawsh default happens to be.
  const current=await row.locator(".breed-class-select").inputValue();
  const nextClass=current==="EXTRA_FLOOF"?"SMOOTH_SINGLE":"EXTRA_FLOOF";
  await row.locator(".breed-class-select").selectOption(nextClass);
  await expect(row.locator(".breed-class-select")).toHaveValue(nextClass);
  // Overriding the Pawsh default is what puts a reset control on the row.
  await expect(row.locator(".breed-reset")).toHaveCount(1);

  // Availability is the other per-business control, and an inactive row hides until asked for.
  await row.locator(".breed-status-toggle").click();
  await expect(row).toHaveCount(0);
  await page.locator("#breed-drawer-show-inactive").check();
  await expect(row.locator(".breed-status-toggle")).toHaveText("Inactive");
  await row.locator(".breed-status-toggle").click();
  await expect(row.locator(".breed-status-toggle")).toHaveText("Active");

  await row.locator(".breed-reset").click();
  await expect(row.locator(".breed-reset")).toHaveCount(0);
  await expect(row.locator(".breed-class-select")).toHaveValue(current);
});

test("@smoke legacy breed catalog routes deep-link into Pet Options",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await expect(page.getByTestId("dashboard").getByText("Breed Catalog")).toHaveCount(0);
  // The standalone page is gone; its URLs resolve to the surface that replaced it.
  for(const path of ["/salon/breeds","/reports/breeds","/overview/breeds"]){
    await page.goto(path);
    await expect(page).toHaveURL(/\/settings\/pet-options$/);
    await expect(page.getByTestId("breed-drawer")).toBeVisible();
    await expect(page.locator("#breed-drawer-title")).toHaveText("Breeds for Dog");
    await page.keyboard.press("Escape");
    await expect(page.locator("#pet-type-body")).toBeVisible();
  }
  await page.getByTestId("nav-reports").click();
  await expect(page.getByTestId("nav-reports")).toHaveAttribute("aria-current","page");
  await expect(page.locator("#reports").getByText("Breed Catalog")).toHaveCount(0);
});

test("@responsive Breed management stays usable without horizontal overflow",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.goto("/settings/pet-options");
  for(const width of [1440,1024,768,430,390]){
    await page.setViewportSize({width,height:900});
    await page.locator("#pet-type-body tr[data-pet-type-row]").nth(0).getByRole("button",{name:"Breeds"}).click();
    await expect(page.getByTestId("breed-drawer")).toBeVisible();
    const row=page.locator("#breed-drawer-list li[data-breed-id]").first();
    await expect(row.locator(".breed-row-name")).toBeVisible();
    await expect(row.locator(".breed-class-select")).toBeVisible();
    await expect(row.locator(".breed-status-toggle")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`width ${width}`).toBe(true);
    await page.keyboard.press("Escape");
  }
});

test("@smoke Settings owns administration while Profile and Services remain separate",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await expect(page.getByTestId("nav-services")).toHaveCount(0);await expect(page.getByTestId("header-services")).toBeVisible();
  await expect(page.getByTestId("nav-setup")).toContainText("Salon");
  const settings=page.getByTestId("nav-settings");await expect(settings).toHaveAccessibleName("Settings");await settings.click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await expect(page.locator("#settings-navigation").getByRole("button",{name:"Account"})).toHaveAttribute("aria-current","page");
  await page.locator("#settings-navigation").getByRole("button",{name:"Permissions"}).click();await expect(page.getByTestId("admin-settings-view").locator("h2",{hasText:"Permissions"})).toBeVisible();
  await page.getByTestId("account-trigger").click();await page.getByTestId("profile-account-link").click();
  await expect(page.getByTestId("profile-account-view")).toBeVisible();
  await expect(page.getByTestId("admin-settings-view")).toBeHidden();
});

test("@smoke primary navigation exposes requested destinations without orphaning Services or Salon",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  const destinations:[string,string][]=[["nav-dashboard","Dashboard"],["nav-calendar","Calendar"],["nav-customers","Clients"],["nav-messages","Messages"],["nav-reminders","Reminders"],["nav-sales","Sales and Expense"],["nav-product","Product"],["nav-reports","Report"],["nav-settings","Settings"]];
  for(const [testId,name] of destinations)await expect(page.getByTestId(testId)).toHaveAccessibleName(name);
  await page.getByTestId("nav-messages").click();await expect(page.locator("#messages").getByRole("heading",{name:"Messages"})).toBeVisible();
  await page.getByTestId("nav-product").click();await expect(page.locator("#product").getByRole("heading",{name:"Product"})).toBeVisible();
  await expect(page.getByTestId("nav-services")).toHaveCount(0);await expect(page.getByTestId("header-services")).toBeVisible();await expect(page.getByTestId("nav-setup")).toBeVisible();
});

test("@smoke desktop navigation is an accessible minimized icon rail",async({page,tenant})=>{
  await page.setViewportSize({width:1440,height:900});await login(page,tenant.ownerEmail);
  const nav=page.locator("#primary-navigation"),calendar=page.getByTestId("nav-calendar");expect((await nav.boundingBox())!.width).toBeLessThanOrEqual(55);await expect(calendar).toHaveAccessibleName("Calendar");await expect(nav.locator(".nav-icon svg")).toHaveCount(10);await expect(nav.locator(".nav-icon").first()).toHaveCSS("border-top-color","rgba(0, 0, 0, 0)");
  const label=calendar.locator("span").last();await expect(label).toHaveCSS("opacity","0");await calendar.focus();await expect(label).toHaveCSS("opacity","1");await calendar.click();await expect(calendar).toHaveAttribute("aria-current","page");await expect(calendar).toHaveClass(/active/);
});

test("@smoke Settings is a deep-linkable categorized workspace with honest canonical links and placeholders",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);await page.getByTestId("nav-settings").click();const navigation=page.locator("#settings-navigation");
  const categories=["Account","Staff","Business","Availability","Appointment schedule","Locations","Permissions","Services","Payroll","Pet options","Tax & payments","Coupons & discounts","Automated messages","SMS auto-reply","Agreements","Online booking","Intake form","Client portal","Loyalty program","Review booster","Report card","Integrations"];
  for(const category of categories)await expect(navigation.getByRole("button",{name:category,exact:true})).toBeVisible();
  await navigation.getByRole("button",{name:"Payroll",exact:true}).click();await expect(page).toHaveURL(/\/settings\/payroll$/);await expect(page.getByTestId("settings-placeholder")).toContainText("not yet available");await expect(page.getByTestId("settings-placeholder").locator("input,select,textarea")).toHaveCount(0);
  await page.reload();await expect(page.getByTestId("admin-settings-view").locator("h2",{hasText:"Payroll"})).toBeVisible();await expect(navigation.getByRole("button",{name:"Payroll",exact:true})).toHaveAttribute("aria-current","page");
  await navigation.getByRole("button",{name:"Services",exact:true}).click();await page.getByRole("button",{name:"Open Services"}).click();await expect(page.getByTestId("services-view")).toBeVisible();
  await page.getByTestId("account-trigger").click();await page.getByTestId("profile-account-link").click();await expect(page.getByTestId("profile-account-view")).toBeVisible();
});

test("@smoke Services is a single top-header catalog with dense grouped filtering",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);await expect(page.getByTestId("nav-services")).toHaveCount(0);const services=page.getByTestId("header-services");await expect(services).toHaveAccessibleName("Services");await services.click();await expect(services).toHaveAttribute("aria-current","page");await expect(page.getByTestId("services-view")).toBeVisible();
  await expect(page.getByTestId("services-view").locator("h3",{hasText:"Services"})).toBeVisible();await expect(page.getByRole("button",{name:"Add service"})).toBeVisible();await expect(page.getByRole("button",{name:"Add category"})).toBeDisabled();await expect(page.locator(".service-category").first()).toBeVisible();
  await page.locator("#service-search").fill("Ear Cleaning");await expect(page.locator(".service-row h4",{hasText:"Ear Cleaning"})).toBeVisible();await expect(page.locator(".service-row h4",{hasText:"Ear Plucking"})).toHaveCount(0);await page.locator("#service-filter-reset").click();await expect(page.locator(".service-row h4",{hasText:"Ear Plucking"})).toBeVisible();
});
