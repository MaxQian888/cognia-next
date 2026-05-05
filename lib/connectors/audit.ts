/**
 * Audit append helper — Task 28.
 *
 * Thin wrapper around `lib/db/connector-audit.ts:append`.
 */

import type { AuditEntry } from "@/types/connectors/audit"
import { append } from "@/lib/db/connector-audit"

export type AuditEntryInput = Omit<AuditEntry, "id"> & Partial<Pick<AuditEntry, "id">>

export async function appendAudit(entry: AuditEntryInput): Promise<AuditEntry> {
  return append(entry)
}
