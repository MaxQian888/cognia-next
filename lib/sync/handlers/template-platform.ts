import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { TemplateDefinitionRow, TemplatePackageRow } from "@/lib/db/template-platform"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
import type { SyncCursor, SyncOutcome, SyncableTable } from "../types"
import { runSyncHandler } from "./base"

function syncPortableTable<TRow extends { id: string }>(
  table: SyncableTable,
  getTable: () => never,
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<TRow>({ table, getTable: getTable as never }, transport, cursor)
}

export function syncTemplateDefinitions(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return syncPortableTable<TemplateDefinitionRow>(
    "templateDefinitions",
    () => getDb().templateDefinitions as never,
    transport,
    cursor
  )
}

export function syncTemplatePackages(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return syncPortableTable<TemplatePackageRow>(
    "templatePackages",
    () => getDb().templatePackages as never,
    transport,
    cursor
  )
}

export function syncTemplateInstances(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return syncPortableTable<TemplateInstanceRecord>(
    "templateInstances",
    () => getDb().templateInstances as never,
    transport,
    cursor
  )
}
