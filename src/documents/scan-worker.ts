import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Database } from "../db/client.js";
import { sha256, type DocumentStorage } from "../storage/documents.js";
import { DocumentScannerError, type DocumentScanner, type DocumentScanResult } from "../security/document-scanner.js";

type Tx = postgres.TransactionSql;
const MAX_ATTEMPTS = 3;

async function tenant(tx: Tx, businessId: string) {
  await tx`select set_config('app.business_id',${businessId},true)`;
}

export interface ScanWorkerSummary { claimed: number; clean: number; rejected: number; retried: number; }

export async function documentScanQueueHealth(db:Database) {
  const [row]=await db<{pending:number;deadLetters:number;oldestSeconds:number|null}[]>`
    select count(*) filter (where r.state='in_progress' and d.state='pending_scan')::int pending,
      count(*) filter (where r.state='failed' and r.result_code='SCAN_DEAD_LETTER')::int dead_letters,
      extract(epoch from now()-min(r.created_at) filter (where r.state='in_progress' and d.state='pending_scan'))::int oldest_seconds
    from pet_document_requests r join pet_documents d on d.request_id=r.id`;
  return row ?? {pending:0,deadLetters:0,oldestSeconds:null};
}

export async function processDocumentScans(
  db: Database, storage: DocumentStorage, scanner: DocumentScanner, limit = 10,
  hooks: { beforeDocumentAudit?: (input:{businessId:string;petId:string;documentId:string})=>Promise<void> } = {}
): Promise<ScanWorkerSummary> {
  const summary = { claimed: 0, clean: 0, rejected: 0, retried: 0 };
  for (let index = 0; index < limit; index += 1) {
    const claimed = await db.begin(async (tx) => {
      const [row] = await tx<{
        requestId:string; businessId:string; documentId:string; objectKey:string; objectSha256:string;
        objectSize:number; attemptNumber:number;
      }[]>`
        select r.id request_id,r.business_id,d.id document_id,d.storage_key object_key,
          d.sha256 object_sha256,d.size_bytes object_size,r.scan_attempt_count+1 attempt_number
        from pet_document_requests r join pet_documents d on d.request_id=r.id
        where r.state='in_progress' and r.scan_available_at<=now() and d.state='pending_scan'
        order by r.scan_available_at,r.created_at,r.id for update of r skip locked limit 1
      `;
      if (!row) return null;
      await tx`update pet_document_requests set scan_available_at=null,scan_attempt_count=${row.attemptNumber},updated_at=now()
        where id=${row.requestId}`;
      return row;
    });
    if (!claimed) break;
    summary.claimed += 1;
    const started = new Date();
    let result: DocumentScanResult | undefined;
    let resultKind: "clean"|"malicious"|"error"|"timeout"|"mismatch" = "error";
    let resultCode = "SCANNER_UNAVAILABLE";
    try {
      const head = await storage.head(claimed.objectKey);
      const object = await storage.get(claimed.objectKey);
      const actualDigest = sha256(object.bytes);
      if (head.size !== Number(claimed.objectSize) || object.size !== Number(claimed.objectSize)
        || actualDigest !== claimed.objectSha256) {
        resultKind = "mismatch"; resultCode = "OBJECT_IDENTITY_MISMATCH";
      } else {
        result = await scanner.scan({ documentId:claimed.documentId,objectKey:claimed.objectKey,bytes:object.bytes,
          sha256:claimed.objectSha256,size:Number(claimed.objectSize) });
        if(result.objectKey!==claimed.objectKey || result.sha256!==claimed.objectSha256 || result.size!==Number(claimed.objectSize)) {
          resultKind="mismatch";resultCode="SCANNER_RESULT_BINDING_MISMATCH";
        } else { resultKind = result.verdict; resultCode = result.code; }
      }
    } catch (error) {
      resultKind = error instanceof DocumentScannerError && error.code === "timeout" ? "timeout" : "error";
      resultCode = error instanceof DocumentScannerError ? `SCANNER_${error.code.toUpperCase()}` : "SCAN_IO_FAILURE";
    }

    try { await db.begin(async (tx) => {
      await tenant(tx, claimed.businessId);
      await tx`insert into pet_document_scan_attempts
        (business_id,document_id,attempt_number,object_key,object_sha256,object_size,
         scanner_engine,scanner_version,signature_version,result,result_code,started_at,completed_at)
        values (${claimed.businessId},${claimed.documentId},${claimed.attemptNumber},${claimed.objectKey},
          ${claimed.objectSha256},${claimed.objectSize},${result?.engine ?? 'unavailable'},
          ${result?.engineVersion ?? 'unknown'},${result?.signatureVersion ?? 'unknown'},
          ${resultKind},${resultCode},${started},now())`;
      if (resultKind === "error" || resultKind === "timeout") {
        if (claimed.attemptNumber < MAX_ATTEMPTS) {
          const delaySeconds = 15 * (2 ** (claimed.attemptNumber - 1));
          await tx`update pet_document_requests set scan_available_at=now()+(${delaySeconds}*interval '1 second'),
            last_scan_error=${resultCode},updated_at=now() where id=${claimed.requestId} and state='in_progress'`;
          summary.retried += 1;
        } else {
          await reject(tx, claimed, "SCAN_DEAD_LETTER", "pet.document.scan_dead_letter"); summary.rejected += 1;
        }
        return;
      }
      if (resultKind !== "clean") {
        await reject(tx, claimed, resultCode, resultKind === "malicious" ? "pet.document.malware_rejected" : "pet.document.integrity_rejected");
        summary.rejected += 1; return;
      }
      const promoted = await promote(tx, claimed, hooks);
      if (promoted) summary.clean += 1; else summary.rejected += 1;
    }); } catch (error) {
      await db`update pet_document_requests set scan_attempt_count=greatest(0,scan_attempt_count-1),
        scan_available_at=now()+interval '15 seconds',last_scan_error='WORKER_TRANSACTION_FAILURE',updated_at=now()
        where id=${claimed.requestId} and state='in_progress' and scan_available_at is null`;
      throw error;
    }
  }
  return summary;
}

async function reject(tx: Tx, row:{requestId:string;businessId:string;documentId:string}, code:string, action:string) {
  await tx`update pet_documents set state='rejected',updated_at=now() where id=${row.documentId} and state='pending_scan'`;
  await tx`update pet_document_requests set state='failed',result_code=${code},completed_at=now(),updated_at=now(),scan_available_at=null
    where id=${row.requestId} and state='in_progress'`;
  await tx`insert into audit_events(business_id,action,resource_type,resource_id,correlation_id,after_data)
    values (${row.businessId},${action},'pet_document',${row.documentId},${randomUUID()},${tx.json({ code })})`;
}

async function promote(tx: Tx, row:{requestId:string;businessId:string;documentId:string},
  hooks:{beforeDocumentAudit?:(input:{businessId:string;petId:string;documentId:string})=>Promise<void>}): Promise<boolean> {
  const [request] = await tx<{
    petId:string; requestedBy:string; membershipId:string; expectedCurrentDocumentId:string|null;
    expectedCurrentDocumentVersion:number|null; expectedPetVersion:number|null; expirationIntent:string; expirationValue:string|null;
  }[]>`select pet_id,requested_by,membership_id,expected_current_document_id,expected_current_document_version,
      expected_pet_version,expiration_intent,expiration_value from pet_document_requests
      where id=${row.requestId} and state='in_progress' for update`;
  if (!request) return false;
  const [membership] = await tx<{isOwner:boolean;permissions:string[]}[]>`
    select is_owner,permissions from business_memberships where business_id=${row.businessId} and id=${request.membershipId}
      and user_id=${request.requestedBy} and status='active'`;
  const allowed = membership && (membership.isOwner ||
    (membership.permissions.includes('pets.edit') && membership.permissions.includes('pets.care.edit')));
  const [pet] = await tx<{version:number;vaccinationExpiresOn:string|null}[]>`
    select p.version,p.vaccination_expires_on from pets p join customers c on c.business_id=p.business_id and c.id=p.customer_id
    where p.business_id=${row.businessId} and p.id=${request.petId} and p.archived_at is null and c.archived_at is null for update of p`;
  const [current] = await tx<{id:string;documentVersion:number}[]>`
    select id,document_version from pet_documents where business_id=${row.businessId} and pet_id=${request.petId}
      and document_type='rabies_vaccination' and state='current' for update`;
  let code = !allowed ? "PERMISSION_REVOKED" : !pet ? "PET_UNAVAILABLE" : "DOCUMENT_STALE";
  let valid = Boolean(allowed && pet);
  if (valid && request.expectedCurrentDocumentId === null) valid = !current;
  else if (valid) valid = Boolean(current && current.id===request.expectedCurrentDocumentId
    && current.documentVersion===request.expectedCurrentDocumentVersion);
  if (valid && request.expirationIntent !== 'preserve' && pet!.version !== request.expectedPetVersion) {
    valid=false; code="PET_STALE";
  }
  if (!valid) { await reject(tx,row,code,"pet.document.promotion_rejected"); return false; }
  let expiration=pet!.vaccinationExpiresOn;
  if(request.expirationIntent==='set') expiration=request.expirationValue;
  if(request.expirationIntent==='clear') expiration=null;
  const careChanged=request.expirationIntent!=='preserve' && expiration!==pet!.vaccinationExpiresOn;
  if(current) await tx`update pet_documents set state='superseded',updated_at=now() where id=${current.id} and state='current'`;
  await tx`update pet_documents set state='current',expires_on=${expiration},updated_at=now()
    where id=${row.documentId} and state='pending_scan'`;
  if(careChanged) await tx`update pets set vaccination_expires_on=${expiration},version=version+1,updated_by=${request.requestedBy},updated_at=now()
    where business_id=${row.businessId} and id=${request.petId}`;
  await hooks.beforeDocumentAudit?.({businessId:row.businessId,petId:request.petId,documentId:row.documentId});
  await tx`update pet_document_requests set state='completed',result_document_id=${row.documentId},result_code='COMPLETED',
    completed_at=now(),updated_at=now() where id=${row.requestId} and state='in_progress'`;
  await tx`insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,after_data)
    values (${row.businessId},${request.requestedBy},${current?'pet.document.replaced':'pet.document.uploaded'},
      'pet_document',${row.documentId},${randomUUID()},${tx.json({petId:request.petId,documentType:'rabies_vaccination',scanRequired:true})})`;
  if(careChanged) await tx`insert into audit_events(business_id,actor_id,action,resource_type,resource_id,correlation_id,after_data)
    values (${row.businessId},${request.requestedBy},'pet.care.update','pet',${request.petId},${randomUUID()},
      ${tx.json({changedFields:['vaccinationExpiresOn']})})`;
  return true;
}
