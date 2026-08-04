import { mkdir,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { digest } from "./canonical.js";
const databaseURL=process.env.DATABASE_URL;const runId=process.env.PAWSH_P1_RUN_ID;
if(!databaseURL||!runId||process.env.PAWSH_E2E_MODE!=="disposable")throw new Error("Disposable P1 database and run ID are required");
const sql=postgres(databaseURL,{max:1,transform:postgres.camel});
try{
  const migrations=await sql<{version:string}[]>`select version from schema_migrations order by version`;
  const [business]=await sql<{id:string}[]>`select id from businesses where name=${`P1 ${runId}`}`;
  if(!business)throw new Error("P1 business was not found");
  const pets=await sql<{id:string;version:number;vaccinationExpiresOn:string|null}[]>`
    select id,version,vaccination_expires_on from pets where business_id=${business.id} order by id`;
  const documents=await sql<{id:string;petId:string;state:string;sha256:string;sizeBytes:number;documentVersion:number}[]>`
    select id,pet_id,state,sha256,size_bytes,document_version from pet_documents where business_id=${business.id} order by id`;
  const attempts=await sql<{documentId:string;attemptNumber:number;result:string;resultCode:string;scannerVersion:string;signatureVersion:string}[]>`
    select document_id,attempt_number,result,result_code,scanner_version,signature_version
    from pet_document_scan_attempts where business_id=${business.id} order by document_id,attempt_number`;
  const requests=await sql<{petId:string;state:string;resultCode:string;scanAttemptCount:number}[]>`
    select pet_id,state,result_code,scan_attempt_count from pet_document_requests where business_id=${business.id} order by id`;
  const [audit]=await sql<{documentSuccess:number;careUpdates:number}[]>`
    select count(*) filter(where action in ('pet.document.uploaded','pet.document.replaced'))::int document_success,
      count(*) filter(where action='pet.care.update')::int care_updates from audit_events where business_id=${business.id}`;
  const manifest=JSON.parse(await readFile(resolve("tests/fixtures/p1/documents/fixture-manifest.json"),"utf8"));
  const evidence={format:"pawsh-p1-execution-evidence-v1",runId,commitSha:process.env.GITHUB_SHA??process.env.PAWSH_P1_SHA??null,
    runtimeDigest:process.env.PAWSH_P1_RUNTIME_DIGEST??null,migrations:migrations.map(row=>row.version),fixtureManifest:manifest,
    databaseRoleClassification:"schema-owner (approved P1 limitation; SEC-DB-001 open)",businessId:business.id,pets,documents,attempts,requests,audit};
  const output={...evidence,executionEvidenceDigest:`sha256:${digest(evidence)}`};
  const directory=resolve("artifacts/p1",runId);await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,"evidence.json"),`${JSON.stringify(output,null,2)}\n`,{encoding:"utf8",mode:0o600});
  console.log(JSON.stringify({runId,evidence:resolve(directory,"evidence.json"),digest:output.executionEvidenceDigest}));
}finally{await sql.end();}
