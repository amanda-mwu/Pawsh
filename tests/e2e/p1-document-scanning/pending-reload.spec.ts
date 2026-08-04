import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test,expect } from "@playwright/test";

const runId=process.env.PAWSH_P1_RUN_ID!;
const scenarioId=process.env.PAWSH_P1_SCENARIO_ID!;
const secret=process.env.PAWSH_P1_SCANNER_CONTROL_SECRET!;
const controlURL=process.env.PAWSH_P1_SCANNER_CONTROL_URL??"http://127.0.0.1:4320";
const fixture=resolve("tests/fixtures/p1/documents/valid-rabies-clean.pdf");
const password="correct horse p1 disposable";

async function control(path:string,value?:unknown){
  const response=await fetch(`${controlURL}${path}`,{method:value?"POST":"GET",headers:{authorization:`Bearer ${secret}`,
    ...(value?{"content-type":"application/json"}:{})},...(value?{body:JSON.stringify(value)}:{})});
  expect(response.ok,await response.text()).toBeTruthy();return response.json();
}

test("@regression-document-scanning preserves pending state across reload and promotes through the worker",async({page,request})=>{
  expect(process.env.PAWSH_E2E_MODE).toBe("disposable");
  const email=`owner+${runId}@example.test`;
  expect((await request.post("/api/auth/signup",{data:{email,password,businessName:`P1 ${runId}`,timezone:"America/Los_Angeles"}})).status()).toBe(201);
  const customerResponse=await request.post("/api/customers",{data:{firstName:"Taylor",lastName:"DocumentTest",email:`taylor+${runId}@example.test`}});
  expect(customerResponse.ok()).toBeTruthy();const customer=await customerResponse.json();
  const petResponse=await request.post("/api/pets",{data:{customerId:customer.id,name:"Maple QA",species:"dog",breed:"Golden Retriever"}});
  expect(petResponse.ok()).toBeTruthy();const pet=await petResponse.json();
  const bytes=await readFile(fixture);const digest=createHash("sha256").update(bytes).digest("hex");const version="p1-control-v1";
  await control("/arm",{runId,scenarioId,version,expectedDigest:digest,documentType:"rabies_vaccination"});

  await page.goto("/");await page.getByRole("button",{name:/already have an account/i}).click();
  await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);
  await page.getByTestId("auth-submit").click();await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.getByTestId("nav-customers").click();
  const card=page.getByTestId("customer-card").filter({hasText:"Taylor"});
  await card.getByRole("button",{name:"Documents"}).click();
  await page.getByTestId("field-rabiesPdf").setInputFiles(fixture);
  await page.locator('input[name="expiration"]').fill("2027-07-15");
  await page.getByTestId("modal-submit").click();
  await expect(page.locator("#modal-error")).toContainText("Malware scan pending");
  let held:{state:string;observed:{documentId:string;size:number}}|undefined;
  await expect.poll(async()=>{held=await control(`/status?run=${encodeURIComponent(runId)}&scenario=${encodeURIComponent(scenarioId)}`) as typeof held;return held?.state;}).toBe("held");

  await page.reload();await page.getByTestId("nav-customers").click();
  await card.getByRole("button",{name:"Documents"}).click();
  await expect(page.getByTestId("rabies-scan-status")).toContainText("Checking document security");
  await expect(page.getByTestId("field-rabiesPdf")).toHaveCount(0);
  await control("/release",{runId,scenarioId,version,documentId:held!.observed.documentId,digest,size:held!.observed.size,verdict:"clean"});
  await expect(page.getByTestId("rabies-current")).toContainText("valid-rabies-clean.pdf",{timeout:15_000});
  await expect(page.getByTestId("rabies-current")).toContainText("7/15/2027");

  const internal=await request.get(`/api/pets/${pet.id}/documents`);expect(internal.ok()).toBeTruthy();
  const body=await internal.json();expect(body.activity).toEqual([]);expect(body.current).toMatchObject({state:"current",expiresOn:"2027-07-15"});
  expect(JSON.stringify(body)).not.toMatch(/storage|objectKey|scanner|signature/i);
});
