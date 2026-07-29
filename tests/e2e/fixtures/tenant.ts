import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { nextMonday, zonedIso } from "../helpers/date.js";

export const password = "correct horse browser smoke";
const ownerPermissions = [
  "calendar.view","appointments.view","appointments.create","appointments.edit","appointments.cancel",
  "customers.view","customers.edit","pets.view","pets.edit","pets.safety.view","pets.safety.edit",
  "operations.check_in","operations.perform_service","operations.complete","checkout.perform",
  "payments.view","discounts.apply","services.manage","team.manage","reports.view","settings.manage"
];

export interface TenantFixture {
  runId: string;
  ownerEmail: string;
  password: string;
  businessId: string;
  ownerMembershipId: string;
  locationId: string;
  employeeId: string;
  serviceId: string;
  customerId: string;
  petId: string;
  rockyCustomerId: string;
  rockyPetId: string;
  sophiaCustomerId: string;
  mochiPetId: string;
  bobaPetId: string;
  anchor: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

function requireDisposableMode(): void {
  if (process.env.PAWSH_E2E_MODE !== "disposable") {
    throw new Error(
      "Mutable Playwright fixtures require PAWSH_E2E_MODE=disposable; refusing destructive setup without an explicit execution mode"
    );
  }
}

export async function createTenant(api: APIRequestContext, label: string): Promise<TenantFixture> {
  requireDisposableMode();
  const runId = `pw-${Date.now()}-${label.replace(/\W+/g,"-").slice(0,18)}-${crypto.randomUUID().slice(0,6)}`;
  const ownerEmail = `owner+${runId}@pawsh-test.example`;
  const signup = await json<{ businessId:string;locationId:string;membershipId:string }>(await api.post("/api/auth/signup",{
    data:{email:ownerEmail,password,businessName:`PW Smoke ${runId}`,timezone:"America/Los_Angeles"}
  }));
  await json(await api.put("/api/business/settings",{data:{
    name:`PW Smoke ${runId}`,timezone:"America/Los_Angeles",currency:"USD",
    taxRateBasisPoints:825,reminderLeadMinutes:1440
  }}));
  await json(await api.put("/api/business/working-hours",{data:{hours:[1,2,3,4,5,6].map((weekday)=>({
    weekday,startTime:weekday===6?"09:00":"08:00",endTime:weekday===6?"16:00":"18:00"
  }))}}));
  const service = await json<{id:string}>(await api.post("/api/services",{data:{
    name:"Full Groom",baseDurationMinutes:90,basePriceMinor:8500
  }}));
  const shortService = await json<{id:string}>(await api.post("/api/services",{data:{
    name:"Nail Trim",baseDurationMinutes:30,basePriceMinor:2000
  }}));
  const employee = await json<{id:string}>(await api.post("/api/employees",{data:{
    displayName:"Grace Groomer",serviceIds:[service.id,shortService.id]
  }}));
  await api.put(`/api/employees/${employee.id}/working-hours`,{data:{hours:[1,2,3,4,5].map((weekday)=>({
    weekday,startTime:"08:00",endTime:"18:00"
  }))}});
  const emma = await json<{id:string}>(await api.post("/api/customers",{data:{
    firstName:"Emma",lastName:"Johnson",phone:"626-555-0101",
    email:`emma+${runId}@pawsh-test.example`,preferredContactMethod:"email",emailAllowed:true
  }}));
  const charlie = await json<{id:string}>(await api.post("/api/pets",{data:{
    customerId:emma.id,name:"Charlie",species:"dog",breed:"Golden Retriever",
    groomingPreferences:"Medium trim; feathering kept natural.",behaviorNotes:"Friendly and calm."
  }}));
  const daniel = await json<{id:string}>(await api.post("/api/customers",{data:{
    firstName:"Daniel",lastName:"Martinez",phone:"626-555-0102",
    email:`daniel+${runId}@pawsh-test.example`,preferredContactMethod:"email",emailAllowed:true
  }}));
  const rocky = await json<{id:string}>(await api.post("/api/pets",{data:{
    customerId:daniel.id,name:"Rocky",species:"dog",breed:"German Shepherd",
    groomingPreferences:"De-shedding",behaviorNotes:"Nervous around paws.",
    medicalNotes:"Mild hip stiffness.",safetyAlerts:"May snap during nail handling."
  }}));
  const sophia = await json<{id:string}>(await api.post("/api/customers",{data:{
    firstName:"Sophia",lastName:"Chen",phone:"626-555-0103",
    email:`sophia+${runId}@pawsh-test.example`,preferredContactMethod:"email",emailAllowed:true
  }}));
  const mochi = await json<{id:string}>(await api.post("/api/pets",{data:{
    customerId:sophia.id,name:"Mochi",species:"dog",breed:"Shih Tzu"
  }}));
  const boba = await json<{id:string}>(await api.post("/api/pets",{data:{
    customerId:sophia.id,name:"Boba",species:"dog",breed:"Pomeranian",safetyAlerts:"Do not shave coat."
  }}));
  return {
    runId,ownerEmail,password,businessId:signup.businessId,ownerMembershipId:signup.membershipId,locationId:signup.locationId,
    employeeId:employee.id,serviceId:service.id,customerId:emma.id,petId:charlie.id,
    rockyCustomerId:daniel.id,rockyPetId:rocky.id,sophiaCustomerId:sophia.id,
    mochiPetId:mochi.id,bobaPetId:boba.id,anchor:nextMonday()
  };
}

export async function createAppointment(
  api: APIRequestContext,
  tenant: TenantFixture,
  options: Partial<{customerId:string;petId:string;startAt:string;serviceIds:string[]}> = {}
) {
  return json<{id:string;version:number}>(await api.post("/api/appointments",{data:{
    locationId:tenant.locationId,customerId:options.customerId??tenant.customerId,
    petId:options.petId??tenant.petId,employeeId:tenant.employeeId,
    serviceIds:options.serviceIds??[tenant.serviceId],
    startAt:options.startAt??zonedIso(tenant.anchor,9)
  }}));
}

export async function completeAppointment(api: APIRequestContext, tenant: TenantFixture) {
  const appointment = await createAppointment(api,tenant);
  let version = appointment.version;
  for (const status of ["checked_in","in_service","completed"]) {
    const result = await json<{version:number}>(await api.post(`/api/appointments/${appointment.id}/transition`,{
      data:{status,version}
    }));
    version=result.version;
  }
  return {...appointment,version};
}

export async function prepareReceipt(api: APIRequestContext, tenant: TenantFixture) {
  const appointment = await completeAppointment(api, tenant);
  const invoice = await json<{id:string;totalMinor:number;balanceMinor:number}>(
    await api.post(`/api/appointments/${appointment.id}/checkout`, {
      data:{discountMinor:500,discountType:"manual",tipMinor:1500}
    })
  );
  await json(await api.post(`/api/invoices/${invoice.id}/payments`, {
    data:{amountMinor:invoice.balanceMinor,method:"cash"}
  }));
  return {appointment,invoice};
}

export async function createMember(
  ownerApi: APIRequestContext,
  email: string,
  permissions: string[]
): Promise<{email:string;membershipId:string}> {
  const invitation = await json<{acceptancePath:string}>(await ownerApi.post("/api/members/invitations",{
    data:{email,permissions}
  }));
  const token = new URL(invitation.acceptancePath,"http://local").searchParams.get("invite")!;
  const memberApi = await playwrightRequest.newContext({baseURL:process.env.PAWSH_E2E_BASE_URL??"http://127.0.0.1:3000"});
  await json(await memberApi.post("/api/auth/invitations/accept",{data:{token,password}}));
  await memberApi.dispose();
  const members = await json<Array<{id:string;email:string}>>(await ownerApi.get("/api/members"));
  return {email,membershipId:members.find((member)=>member.email===email)!.id};
}

type Fixtures = { tenant: TenantFixture };
export const test = base.extend<Fixtures>({
  page: async ({page},use,testInfo) => {
    const failures:string[]=[];
    const requestEvidence:string[]=[];
    page.on("pageerror",(error)=>failures.push(error.message));
    page.on("console",(message)=>{
      if(message.type()==="error" && !message.text().startsWith("Failed to load resource:")) failures.push(message.text());
    });
    page.on("requestfailed",(request)=>{
      const evidence=`FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText??"unknown error"}`;
      requestEvidence.push(evidence);
    });
    page.on("response",(response)=>{
      if(response.status()>=400)requestEvidence.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      if(response.status()>=500)failures.push(`${response.status()} ${response.url()}`);
    });
    await use(page);
    if(testInfo.status!==testInfo.expectedStatus && requestEvidence.length) {
      await attachText(testInfo,"browser-request-evidence",requestEvidence);
    }
    expect(failures,failures.join("\n")).toEqual([]);
  },
  tenant: async ({request},use,testInfo) => {
    await use(await createTenant(request,`${testInfo.parallelIndex}-${testInfo.title}`));
  }
});
export { expect, ownerPermissions };

async function attachText(testInfo: TestInfo, name: string, lines: string[]): Promise<void> {
  await testInfo.attach(name,{
    body:Buffer.from(lines.join("\n"),"utf8"),
    contentType:"text/plain"
  });
}

export async function login(page: Page,email:string,passwordValue=password) {
  await page.goto("/");
  await expect(
    page.getByTestId("dashboard").or(page.getByTestId("auth-form"))
  ).toBeVisible();
  if(await page.getByTestId("dashboard").isVisible()) {
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("auth-form")).toBeVisible();
  }
  await page.getByRole("button",{name:/already have an account/i}).click();
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(passwordValue);
  const loginResponse=page.waitForResponse((response)=>
    response.url().endsWith("/api/auth/login") && response.request().method()==="POST"
  );
  await page.getByTestId("auth-submit").click();
  expect((await loginResponse).status()).toBe(200);
  await expect(page.getByTestId("dashboard")).toBeVisible();
}
