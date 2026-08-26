/* global console, process */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalHash, normalizeLineEndings, withoutVariableFields } from "../dist/domain/canonical.js";
import { calculateInvoice } from "@pawsh/domain";
import { localDateBounds, resolveWallTime } from "../dist/domain/time.js";

const notes = normalizeLineEndings("Calm 🐾\r\nUse café shampoo\rSecond line");
const schedulingIntent = [
  "appointment.create",
  "appointment.create:v1",
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  ["00000000-0000-4000-8000-000000000004"],
  "2026-11-01T01:30",
  "later",
  false,
  notes
];
const invoice = calculateInvoice({ lineAmounts: [8500, 2000], discount: 500, taxRateBasisPoints: 825, tip: 1500 });
const repeated = resolveWallTime("2026-11-01T01:30", "America/Los_Angeles", "later");
const springDay = localDateBounds("2026-03-08", "America/Los_Angeles");
const normalizedAudit = withoutVariableFields({
  id: "variable", createdAt: "variable", correlationId: "variable",
  action: "appointment.created", resourceType: "appointment",
  afterData: { changedFields: ["startAt"], notes }
}, ["id", "createdAt", "correlationId"]);
const normalizedOutbox = withoutVariableFields({
  id: "variable", createdAt: "variable", eventType: "AppointmentCreated",
  payload: { appointmentVersion: 1, localStart: "2026-11-01T01:30", notes }
}, ["id", "createdAt"]);
const fixture = {
  schemaVersion: "pawsh-cross-platform:v1",
  schedulingCanonicalHash: canonicalHash(schedulingIntent),
  financialCanonicalHash: canonicalHash({ version: 1, invoiceId: "00000000-0000-4000-8000-000000000005", amountMinor: 3400, method: "cash", externalReference: null }),
  replayCanonicalHash: canonicalHash(["appointment.reschedule", "appointment.reschedule:v1", "00000000-0000-4000-8000-000000000006", 2, "2026-11-01T01:30", "later"]),
  contentDigest: canonicalHash({ customer: "Zoë", employee: "李 Groomer", pet: "Señor 🐕", service: "Bain & brosse", notes }),
  invoice,
  repeatedWallTime: { instant: repeated.instant.toISOString(), offsetMinutes: repeated.offsetMinutes, disambiguation: repeated.disambiguation },
  springBusinessDayHours: (springDay.to.getTime() - springDay.from.getTime()) / 3_600_000,
  utcTimestamp: new Date("2026-02-03T04:05:06.000Z").toISOString(),
  normalizedAudit,
  normalizedOutbox
};
const output = resolve(process.argv[2] ?? "artifacts/cross-platform-fixture.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(canonicalHash(fixture));
