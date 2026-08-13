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
  await page.getByTestId("business-settings").click();
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

test("@smoke breed catalog is compact, searchable, editable, and duplicate-safe",async({page,tenant})=>{
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
  const name=`QA Coat Dog ${tenant.runId.slice(-8)}`;
  await page.getByTestId("breed-add-name").fill(name);
  await page.getByTestId("breed-add-class").selectOption("EXTRA_FLOOF");
  await page.getByRole("button",{name:"Add breed"}).click();
  await page.getByTestId("breed-search").fill(name);
  const row=page.locator("#breed-catalog-body tr[data-breed-id]").filter({hasText:name});
  await expect(row).toContainText("Extra Floof");
  const breedId=await row.getAttribute("data-breed-id");
  await row.getByLabel(`Actions for ${name}`).click();
  await row.getByRole("button",{name:"Edit"}).click();
  const editingRow=page.locator(`#breed-catalog-body tr[data-breed-id="${breedId}"]`);
  await editingRow.locator(".breed-edit-class").selectOption("STANDARD");
  await editingRow.locator(".breed-save").click();
  await expect(page.locator("#breed-catalog-body tr[data-breed-id]").filter({hasText:name})).toContainText("Standard");
  await page.getByTestId("breed-add-name").fill(`  ${name.toUpperCase().replaceAll(" ","   ")}  `);
  await page.getByRole("button",{name:"Add breed"}).click();
  await expect(page.locator("#breed-add-error")).toContainText(`Breed already exists: ${name}`);
  const updatedRow=page.locator("#breed-catalog-body tr[data-breed-id]").filter({hasText:name});
  await updatedRow.getByLabel(`Actions for ${name}`).click();
  await updatedRow.getByRole("button",{name:"Deactivate"}).click();
  await expect(updatedRow).toHaveCount(0);
  await page.locator("#breed-show-inactive").check();
  const inactiveRow=page.locator("#breed-catalog-body tr[data-breed-id]").filter({hasText:name});
  await expect(inactiveRow).toContainText("Inactive");
  await inactiveRow.getByLabel(`Actions for ${name}`).click();
  await inactiveRow.getByRole("button",{name:"Reactivate"}).click();
  await expect(page.locator("#breed-catalog-body tr[data-breed-id]").filter({hasText:name})).toContainText("Active");
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
  await expect(page.locator("#reports").getByRole("heading",{name:"Business reports"})).toBeVisible();
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
  await expect(page.getByTestId("nav-services")).toBeVisible();
  await expect(page.getByTestId("nav-setup")).toContainText("Salon");
  const settings=page.getByTestId("nav-settings");await expect(settings).toHaveAccessibleName("Settings");await settings.click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await expect(page.getByRole("heading",{name:"Workspace access"})).toBeVisible();
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
  await expect(page.getByTestId("nav-services")).toBeVisible();await expect(page.getByTestId("nav-setup")).toBeVisible();
});
