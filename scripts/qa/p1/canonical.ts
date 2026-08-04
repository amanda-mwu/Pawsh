import { createHash } from "node:crypto";

function validUnicode(value:string):boolean {
  for(let index=0;index<value.length;index+=1){
    const code=value.charCodeAt(index);
    if(code>=0xd800&&code<=0xdbff){if(index+1>=value.length)return false;const next=value.charCodeAt(index+1);if(next<0xdc00||next>0xdfff)return false;index+=1;}
    else if(code>=0xdc00&&code<=0xdfff)return false;
  }
  return true;
}

export function canonicalize(value:unknown):string {
  if(value===null)return "null";
  if(typeof value==="boolean")return value?"true":"false";
  if(typeof value==="number"){if(!Number.isFinite(value))throw new Error("JCS rejects non-finite numbers");return JSON.stringify(value);}
  if(typeof value==="string"){if(!validUnicode(value))throw new Error("JCS rejects lone Unicode surrogates");return JSON.stringify(value);}
  if(Array.isArray(value))return `[${value.map(canonicalize).join(",")}]`;
  if(typeof value==="object"){
    const record=value as Record<string,unknown>;
    const entries=Object.keys(record).sort().map((key)=>{
      if(record[key]===undefined)throw new Error("JCS rejects undefined values");
      return `${canonicalize(key)}:${canonicalize(record[key])}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`JCS cannot encode ${typeof value}`);
}

export function digest(value:unknown):string {
  return createHash("sha256").update(canonicalize(value),"utf8").digest("hex");
}
