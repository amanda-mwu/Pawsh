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

test("@smoke breed catalog is compact, searchable, and salon-overridable",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.getByTestId("nav-setup").click();
  await expect(page.locator("#breed-admin-list")).toHaveCount(0);
  await page.locator("#setup .setup-menu summary").click();
  await page.locator("#setup .setup-menu").getByRole("link",{name:"Breed catalog",exact:true}).click();
  await expect(page.getByTestId("breed-catalog-view")).toBeVisible();
  await expect(page).toHaveURL(/\/salon\/breeds$/);
  await expect(page.getByTestId("nav-setup")).toHaveAttribute("aria-current","page");
  await expect(page.getByTestId("nav-reports")).not.toHaveAttribute("aria-current","page");
  await expect(page.locator("#page-title")).toHaveText("Salon");
  await expect(page.getByRole("heading",{name:"Business reports"})).toBeHidden();
  expect(await page.locator("#breed-catalog-body tr[data-breed-id]").count()).toBeGreaterThan(20);
  // Breeds are shared Pawsh taxonomy now: a salon overrides a row, it never creates or renames one.
  await expect(page.getByTestId("breed-add-name")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Add breed"})).toHaveCount(0);
  const first=page.locator("#breed-catalog-body tr[data-breed-id]").first();
  const breedId=await first.getAttribute("data-breed-id");
  const name=(await first.locator("strong").innerText()).trim();
  await page.getByTestId("breed-search").fill(name);
  const row=page.locator(`#breed-catalog-body tr[data-breed-id="${breedId}"]`);
  await expect(row).toContainText("Pawsh default");
  await row.getByLabel(`Actions for ${name}`).click();
  await row.getByRole("button",{name:"Edit"}).click();
  await expect(row.locator(".breed-edit-name")).toHaveCount(0);
  // Pick a class the row is not already on, so the save is a real override whatever the Pawsh default is.
  const current=await row.locator(".breed-edit-class").inputValue();
  const [nextClass,nextLabel]=current==="EXTRA_FLOOF"?["SMOOTH_SINGLE","Smooth Single"]:["EXTRA_FLOOF","Extra Floof"];
  await row.locator(".breed-edit-class").selectOption(nextClass);
  await row.locator(".breed-save").click();
  await expect(row).toContainText(nextLabel);
  await expect(row).toContainText("Customized");
  await row.getByLabel(`Actions for ${name}`).click();
  await row.getByRole("button",{name:"Deactivate"}).click();
  await expect(row).toHaveCount(0);
  await page.locator("#breed-show-inactive").check();
  await expect(row).toContainText("Inactive");
  await row.getByLabel(`Actions for ${name}`).click();
  await row.getByRole("button",{name:"Reactivate"}).click();
  await expect(row).toContainText("Active");
  await row.getByLabel(`Actions for ${name}`).click();
  await row.getByRole("button",{name:"Reset to Pawsh default"}).click();
  await expect(row).toContainText("Pawsh default");
  await expect(row).not.toContainText("Customized");
});

test("@smoke breed catalog route restores Salon navigation and redirects legacy routes",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await expect(page.getByTestId("dashboard").getByText("Breed Catalog")).toHaveCount(0);
  await page.goto("/salon/breeds");
  await expect(page.getByTestId("breed-catalog-view")).toBeVisible();
  await expect(page.getByTestId("nav-setup")).toHaveAttribute("aria-current","page");
  await expect(page.getByTestId("nav-reports")).not.toHaveAttribute("aria-current","page");
  await expect(page.locator("#page-title")).toHaveText("Salon");
  await expect(page.getByRole("navigation",{name:"Breadcrumb"})).toContainText("Salon/Breed Catalog");
  await page.reload();
  await expect(page.getByTestId("breed-catalog-view")).toBeVisible();
  await expect(page.getByTestId("nav-setup")).toHaveAttribute("aria-current","page");
  await page.goto("/reports/breeds");
  await expect(page).toHaveURL(/\/salon\/breeds$/);
  await expect(page.getByTestId("nav-setup")).toHaveAttribute("aria-current","page");
  const settingsMenu=page.locator("#breed-catalog .setup-menu summary");
  await settingsMenu.click();
  await expect(settingsMenu).toHaveAttribute("aria-expanded","true");
  await page.keyboard.press("Escape");
  await expect(settingsMenu).toHaveAttribute("aria-expanded","false");
  await expect(settingsMenu).toBeFocused();
  await page.getByTestId("nav-reports").click();
  await expect(page.getByTestId("nav-reports")).toHaveAttribute("aria-current","page");
  await expect(page.getByTestId("breed-catalog-view")).toBeHidden();
  await expect(page.locator("#reports").getByRole("heading",{name:"Dashboard reporting"})).toBeVisible();
  await expect(page.locator("#reports").getByText("Breed Catalog")).toHaveCount(0);
});

test("@responsive Breed Catalog preserves compact Salon context without horizontal overflow",async({page,tenant})=>{
  await login(page,tenant.ownerEmail);
  await page.goto("/salon/breeds");
  for(const width of [1440,1024,768,430,390]){
    await page.setViewportSize({width,height:900});
    await expect(page.getByTestId("breed-catalog-view")).toBeVisible();
    await expect(page.getByTestId("nav-setup")).toHaveAttribute("aria-current","page");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator("#breed-catalog .setup-menu summary")).toBeVisible();
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
