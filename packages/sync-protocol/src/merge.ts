/**
 * Merge (protocol §9): per field, the write with the greater clock wins.
 *
 * Deletes are row-level. A delete removes the row unless the row holds a
 * field written after it; then the row survives, and the device that kept it
 * re-sends the whole row (`survive`) so a device that already removed it can
 * rebuild it. An upsert to a removed row recreates it only if it is newer
 * than the delete, and then every field it carries applies.
 *
 * Pure: the caller reads the row's clocks, applies the result to the row and
 * stores the new clocks in the same transaction.
 */

import { maxHlc } from "./hlc"
import type { ClockedValue } from "./ops"

export interface RowClocks {
  /** Field name → encoded clock of the write that set it. */
  fields: Record<string, string>
  /** The clock of the latest delete of this row. */
  tombstone?: string
}

export type MergeResult =
  | { kind: "ignore" }
  | {
      kind: "write"
      /** Fields to set on the row; `created` means the row did not exist. */
      fields: Record<string, unknown>
      created: boolean
      clocks: RowClocks
    }
  | { kind: "delete"; clocks: RowClocks }
  | { kind: "survive"; clocks: RowClocks }

function withTombstone(fields: Record<string, string>, tombstone: string | undefined): RowClocks {
  return tombstone === undefined ? { fields } : { fields, tombstone }
}

export function mergeUpsert(
  exists: boolean,
  clocks: RowClocks | undefined,
  incoming: Record<string, ClockedValue>
): MergeResult {
  const entries = Object.entries(incoming)
  if (entries.length === 0) return { kind: "ignore" }
  if (!exists) {
    const newest = maxHlc(entries.map(([, [, hlc]]) => hlc))!
    if (clocks?.tombstone !== undefined && newest <= clocks.tombstone) return { kind: "ignore" }
    const fields: Record<string, unknown> = {}
    const fieldClocks: Record<string, string> = {}
    for (const [name, [value, hlc]] of entries) {
      fields[name] = value
      fieldClocks[name] = hlc
    }
    return {
      kind: "write",
      fields,
      created: true,
      clocks: withTombstone(fieldClocks, clocks?.tombstone),
    }
  }
  const current = clocks?.fields ?? {}
  const fields: Record<string, unknown> = {}
  const fieldClocks: Record<string, string> = { ...current }
  let won = false
  for (const [name, [value, hlc]] of entries) {
    const held = current[name]
    if (held !== undefined && hlc <= held) continue
    fields[name] = value
    fieldClocks[name] = hlc
    won = true
  }
  if (!won) return { kind: "ignore" }
  return {
    kind: "write",
    fields,
    created: false,
    clocks: withTombstone(fieldClocks, clocks?.tombstone),
  }
}

export function mergeDelete(
  exists: boolean,
  clocks: RowClocks | undefined,
  at: string
): MergeResult {
  if (clocks?.tombstone !== undefined && at <= clocks.tombstone) return { kind: "ignore" }
  const newestField = maxHlc(Object.values(clocks?.fields ?? {}))
  if (exists && newestField !== null && newestField > at)
    return { kind: "survive", clocks: { fields: { ...clocks!.fields }, tombstone: at } }
  return { kind: "delete", clocks: { fields: {}, tombstone: at } }
}
