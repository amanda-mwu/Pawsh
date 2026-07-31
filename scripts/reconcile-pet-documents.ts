import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { createDocumentStorage, DocumentStorageError } from "../src/storage/documents.js";

const config = loadConfig();
const db = createDatabase(config);
const storage = createDocumentStorage(config);
const apply = process.argv.includes("--apply");
const tenantArgument = process.argv.find((value) => value.startsWith("--tenant="));
const tenantId = tenantArgument?.slice("--tenant=".length);
const batchArgument = process.argv.find((value) => value.startsWith("--batch="));
const batch = Math.min(100, Math.max(1, Number(batchArgument?.slice("--batch=".length) ?? 25)));

if (!tenantId && !process.argv.includes("--all-tenants")) {
  throw new Error("Specify --tenant=<business UUID> or explicit --all-tenants");
}

let failures = 0;
try {
  const rows = await db<{
    id: string; businessId: string; petId: string; requestId: string | null; storageKey: string;
  }[]>`
    select id,business_id,pet_id,request_id,storage_key
    from pet_documents
    where state='pending' and created_at < now()-interval '1 hour'
      and (${tenantId ?? null}::uuid is null or business_id=${tenantId ?? null}::uuid)
    order by created_at,id limit ${batch}
  `;
  for (const row of rows) {
    let exists = false;
    try { await storage.head(row.storageKey); exists = true; }
    catch (error) {
      if (!(error instanceof DocumentStorageError) || error.code !== "storage_not_found") {
        failures += 1;
        console.error(JSON.stringify({ documentId: row.id, status: "head_failed" }));
        continue;
      }
    }
    console.log(JSON.stringify({ documentId: row.id, businessId: row.businessId, objectExists: exists, action: apply ? "cleanup" : "dry_run" }));
    if (!apply) continue;
    const stillPending = await db.begin(async (tx) => {
      const [locked] = await tx<{ id: string }[]>`
        select id from pet_documents where id=${row.id} and business_id=${row.businessId}
          and state='pending' and created_at < now()-interval '1 hour' for update
      `;
      if (!locked) return false;
      if (exists) await storage.delete(row.storageKey);
      if (row.requestId) await tx`update pet_document_requests set state='failed',result_code='RECONCILED_STALE',
        completed_at=now(),updated_at=now() where id=${row.requestId} and state='in_progress'`;
      await tx`delete from pet_documents where id=${row.id} and state='pending'`;
      await tx`insert into audit_events
        (business_id,action,resource_type,resource_id,correlation_id,after_data)
        values (${row.businessId},'pet.document.pending_cleaned','pet_document',${row.id},${randomUUID()},
          ${tx.json({ petId: row.petId, objectRemoved: exists })})`;
      return true;
    });
    if (!stillPending) console.log(JSON.stringify({ documentId: row.id, status: "changed_before_cleanup" }));
  }
  const expiredRequests = await db<{ id: string; businessId: string }[]>`
    select id,business_id from pet_document_requests
    where state in ('completed','failed','conflict') and updated_at < now()-interval '7 days'
      and (${tenantId ?? null}::uuid is null or business_id=${tenantId ?? null}::uuid)
    order by updated_at,id limit ${batch}
  `;
  for (const request of expiredRequests) {
    console.log(JSON.stringify({ requestId: request.id, businessId: request.businessId,
      action: apply ? "expire_request_identity" : "dry_run_expire_request_identity" }));
    if (apply) await db`delete from pet_document_requests where id=${request.id}
      and state in ('completed','failed','conflict') and updated_at < now()-interval '7 days'`;
  }
} finally {
  await db.end();
}
if (failures) process.exitCode = 1;
