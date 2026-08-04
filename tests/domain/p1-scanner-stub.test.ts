import { spawn,type ChildProcess } from "node:child_process";
import { afterAll,beforeAll,describe,expect,it } from "vitest";

const scanPort=14319;const controlPort=14320;const secret="test-control-secret";const scanToken="test-scan-token";
let child:ChildProcess;
async function waitReady(){
  for(let attempt=0;attempt<100;attempt+=1){
    try{const response=await fetch(`http://127.0.0.1:${controlPort}/status?run=none&scenario=none`,{headers:{authorization:`Bearer ${secret}`}});
      if(response.status===404)return;}catch(error){if(attempt===99)throw error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error("scanner stub did not start");
}
async function control(path:string,value:unknown,token=secret){return fetch(`http://127.0.0.1:${controlPort}${path}`,{
  method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(value)});}

describe("P1 scanner stub control binding",()=>{
  beforeAll(async()=>{
    child=spawn(process.execPath,["--import","tsx","tools/qa-scanner-stub/server.ts"],{stdio:"ignore",env:{...process.env,
      PAWSH_E2E_MODE:"disposable",PAWSH_P1_SCANNER_PORT:String(scanPort),PAWSH_P1_SCANNER_CONTROL_PORT:String(controlPort),
      PAWSH_P1_SCANNER_CONTROL_SECRET:secret,PAWSH_P1_SCANNER_TOKEN:scanToken}});
    await waitReady();
  });
  afterAll(()=>child?.kill());

  it("requires control authentication and exact held-request identity",async()=>{
    const digest="a".repeat(64);const identity={runId:"run-a",scenarioId:"clean",version:"v1"};
    expect((await control("/arm",{...identity,expectedDigest:digest,documentType:"rabies_vaccination"},"wrong")).status).toBe(401);
    expect((await control("/arm",{...identity,expectedDigest:digest,documentType:"rabies_vaccination"})).status).toBe(201);
    const scan=fetch(`http://127.0.0.1:${scanPort}/scan?run=run-a&scenario=clean`,{method:"POST",
      headers:{authorization:`Bearer ${scanToken}`,"content-type":"application/json"},body:JSON.stringify({
        documentId:"10000000-0000-4000-8000-000000000001",objectKey:"business/a/document/1",sha256:digest,size:114})});
    await expect.poll(async()=>fetch(`http://127.0.0.1:${controlPort}/status?run=run-a&scenario=clean`,{
      headers:{authorization:`Bearer ${secret}`}}).then(response=>response.json()).then(value=>value.state)).toBe("held");
    expect((await control("/release",{...identity,documentId:"wrong",digest,size:114,verdict:"clean"})).status).toBe(409);
    expect((await control("/release",{...identity,documentId:"10000000-0000-4000-8000-000000000001",digest,size:114,verdict:"clean"})).status).toBe(200);
    const result=await scan;expect(result.status).toBe(200);expect(await result.json()).toMatchObject({verdict:"clean",sha256:digest,size:114});
  });
});
