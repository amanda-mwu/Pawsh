import { createServer, type ServerResponse } from "node:http";

type Verdict = "clean" | "malicious";
type Failure = "unavailable" | "malformed" | "timeout";
interface ScanInput { documentId:string;objectKey:string;sha256:string;size:number }
interface Control {
  runId:string;scenarioId:string;version:string;expectedDigest:string;documentType:string;
  state:"armed"|"held"|"released"; observed?:ScanInput; response?:ServerResponse;
}

const scanPort=Number(process.env.PAWSH_P1_SCANNER_PORT??"4319");
const controlPort=Number(process.env.PAWSH_P1_SCANNER_CONTROL_PORT??"4320");
const controlSecret=process.env.PAWSH_P1_SCANNER_CONTROL_SECRET;
const scanToken=process.env.PAWSH_P1_SCANNER_TOKEN;
if(process.env.PAWSH_E2E_MODE!=="disposable"||!controlSecret||!scanToken) {
  throw new Error("P1 scanner stub requires disposable mode and run-scoped scanner secrets");
}
const controls=new Map<string,Control>();
const key=(run:string,scenario:string)=>`${run}\0${scenario}`;
const json=(response:ServerResponse,status:number,value:unknown)=>{
  response.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});
  response.end(JSON.stringify(value));
};
async function body(request:NodeJS.ReadableStream){
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
}

const scanServer=createServer(async(request,response)=>{
  const url=new URL(request.url??"/","http://127.0.0.1");
  if(request.method!=="POST"||url.pathname!=="/scan")return json(response,404,{error:"not found"});
  if(request.headers.authorization!==`Bearer ${scanToken}`)return json(response,401,{error:"unauthorized"});
  const runId=url.searchParams.get("run")??"";const scenarioId=url.searchParams.get("scenario")??"";
  const control=controls.get(key(runId,scenarioId));
  if(!control||control.state!=="armed")return json(response,409,{error:"scanner control is not armed"});
  const value=await body(request) as unknown as ScanInput;
  if(value.sha256!==control.expectedDigest||value.documentId===""||value.objectKey===""||!Number.isSafeInteger(value.size)) {
    return json(response,409,{error:"scanner request identity mismatch"});
  }
  control.state="held";control.observed=value;control.response=response;
});

const controlServer=createServer(async(request,response)=>{
  if(request.headers.authorization!==`Bearer ${controlSecret}`)return json(response,401,{error:"unauthorized"});
  const url=new URL(request.url??"/","http://127.0.0.1");
  if(request.method==="GET"&&url.pathname==="/status"){
    const control=controls.get(key(url.searchParams.get("run")??"",url.searchParams.get("scenario")??""));
    return control?json(response,200,{...control,response:undefined}):json(response,404,{error:"control not found"});
  }
  if(request.method!=="POST")return json(response,404,{error:"not found"});
  const value=await body(request);
  const runId=String(value.runId??"");const scenarioId=String(value.scenarioId??"");
  if(!runId||!scenarioId)return json(response,400,{error:"run and scenario are required"});
  const controlKey=key(runId,scenarioId);
  if(url.pathname==="/arm"){
    if(controls.has(controlKey))return json(response,409,{error:"control already exists"});
    const control:Control={runId,scenarioId,version:String(value.version??""),expectedDigest:String(value.expectedDigest??""),
      documentType:String(value.documentType??""),state:"armed"};
    if(!/^[0-9a-f]{64}$/.test(control.expectedDigest)||control.documentType!=="rabies_vaccination"||!control.version) {
      return json(response,400,{error:"invalid control identity"});
    }
    controls.set(controlKey,control);return json(response,201,{state:"armed"});
  }
  const control=controls.get(controlKey);
  if(!control||control.state!=="held"||!control.observed||!control.response)return json(response,409,{error:"request is not held"});
  if(String(value.version??"")!==control.version||String(value.documentId??"")!==control.observed.documentId
    ||String(value.digest??"")!==control.observed.sha256||Number(value.size)!==control.observed.size) {
    return json(response,409,{error:"release identity mismatch"});
  }
  control.state="released";
  if(url.pathname==="/release"){
    const verdict=String(value.verdict) as Verdict;
    if(verdict!=="clean"&&verdict!=="malicious")return json(response,400,{error:"invalid verdict"});
    json(control.response,200,{...control.observed,verdict,engine:"pawsh-p1-stub",engineVersion:"1",
      signatureVersion:"safe-fixtures-v1",code:verdict==="clean"?"CLEAN":"MALWARE_SIMULATED"});
  } else if(url.pathname==="/fail") {
    const mode=String(value.mode) as Failure;
    if(mode==="unavailable")json(control.response,503,{error:"simulated unavailable"});
    else if(mode==="malformed"){control.response.writeHead(200,{"content-type":"application/json"});control.response.end("{");}
    else if(mode!=="timeout")return json(response,400,{error:"invalid failure mode"});
  } else return json(response,404,{error:"not found"});
  control.response=undefined;return json(response,200,{state:"released"});
});

scanServer.listen(scanPort,"127.0.0.1",()=>console.log(`P1 scanner scan interface listening on 127.0.0.1:${scanPort}`));
controlServer.listen(controlPort,"127.0.0.1",()=>console.log(`P1 scanner control interface listening on 127.0.0.1:${controlPort}`));

const close=()=>{scanServer.close();controlServer.close();};
process.once("SIGTERM",close);process.once("SIGINT",close);
