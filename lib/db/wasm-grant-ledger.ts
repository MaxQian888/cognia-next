import { getDb } from "./schema"

export type WasmGrantSource = "user" | "system" | "manifest" | "localStorage"

/**
 * Durable WASM preopen grant ledger. One row is one approved preopen path for
 * one plugin; replacing a plugin's grant set deletes stale rows first so
 * plugin updates cannot inherit paths that disappeared from the manifest.
 */
export interface WasmGrantLedgerRow {
  id: string
  pluginId: string
  preopen: string
  source: WasmGrantSource
  grantedAt: number
}

export function wasmGrantRecordId(pluginId: string, preopen: string): string {
  return `${pluginId}:${encodeURIComponent(preopen)}`
}

export async function replaceWasmGrantRecords(
  pluginId: string,
  preopens: readonly string[],
  source: WasmGrantSource,
  grantedAt = Date.now()
): Promise<WasmGrantLedgerRow[]> {
  const db = getDb()
  const unique = Array.from(new Set(preopens.map((path) => path.trim()).filter(Boolean))).sort()
  const rows = unique.map((preopen) => ({
    id: wasmGrantRecordId(pluginId, preopen),
    pluginId,
    preopen,
    source,
    grantedAt,
  }))
  await db.transaction("rw", db.wasmGrantLedger, async () => {
    await db.wasmGrantLedger.where("pluginId").equals(pluginId).delete()
    if (rows.length > 0) {
      await db.wasmGrantLedger.bulkPut(rows)
    }
  })
  return rows
}

export async function listWasmGrantRecords(pluginId: string): Promise<WasmGrantLedgerRow[]> {
  const db = getDb()
  const rows = await db.wasmGrantLedger.where("pluginId").equals(pluginId).toArray()
  return rows.sort((a, b) => a.preopen.localeCompare(b.preopen))
}

export async function clearWasmGrantRecords(pluginId: string): Promise<void> {
  const db = getDb()
  await db.wasmGrantLedger.where("pluginId").equals(pluginId).delete()
}
