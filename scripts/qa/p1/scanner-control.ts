const args=new Map<string,string>();
const values=process.argv.slice(2);const command=values.shift();
for(let index=0;index<values.length;index+=2){const name=values[index];if(!name?.startsWith("--"))throw new Error(`Invalid argument ${name}`);args.set(name.slice(2),values[index+1]??"");}
const required=(name:string)=>{const value=args.get(name);if(!value)throw new Error(`--${name} is required`);return value;};
const endpoint=process.env.PAWSH_P1_SCANNER_CONTROL_URL??"http://127.0.0.1:4320";
const secret=process.env.PAWSH_P1_SCANNER_CONTROL_SECRET;if(!secret)throw new Error("PAWSH_P1_SCANNER_CONTROL_SECRET is required");
const runId=required("run");const scenarioId=required("scenario");
async function call(path:string,body?:unknown){
  const response=await fetch(`${endpoint}${path}`,{method:body?"POST":"GET",headers:{authorization:`Bearer ${secret}`,
    ...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(result)}`);return result;
}
let result:unknown;
if(command==="arm")result=await call("/arm",{runId,scenarioId,version:required("control-version"),
  expectedDigest:required("expected-digest"),documentType:required("document-type")});
else if(command==="status")result=await call(`/status?run=${encodeURIComponent(runId)}&scenario=${encodeURIComponent(scenarioId)}`);
else if(command==="await-held"){
  const deadline=Date.now()+Number(required("timeout"))*1000;
  do{try{result=await call(`/status?run=${encodeURIComponent(runId)}&scenario=${encodeURIComponent(scenarioId)}`);
    if((result as {state:string}).state==="held")break;}catch{result=undefined;} await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
  if((result as {state?:string}|undefined)?.state!=="held")throw new Error("Timed out waiting for held scanner request");
} else if(command==="release"||command==="fail") result=await call(`/${command}`,{runId,scenarioId,
  version:required("control-version"),documentId:required("document"),digest:required("digest"),size:Number(required("size")),
  ...(command==="release"?{verdict:required("verdict")}:{mode:required("mode")})});
else throw new Error("Command must be arm, await-held, status, release, or fail");
console.log(JSON.stringify(result,null,2));
