import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
interface Manifest {containsActiveMalware:boolean;fixtures:Array<{name:string;sha256:string;size:number}>}
const root=resolve("tests/fixtures/p1/documents");
const manifest=JSON.parse(await readFile(resolve(root,"fixture-manifest.json"),"utf8")) as Manifest;
if(manifest.containsActiveMalware)throw new Error("Active malware fixtures are prohibited");
for(const fixture of manifest.fixtures){
  const bytes=await readFile(resolve(root,fixture.name));const digest=createHash("sha256").update(bytes).digest("hex");
  if(digest!==fixture.sha256||bytes.byteLength!==fixture.size)throw new Error(`Fixture drift: ${fixture.name}`);
}
console.log(`Verified ${manifest.fixtures.length} safe synthetic P1 fixtures`);
