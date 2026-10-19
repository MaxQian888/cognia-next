/**
 * Backup import for code-owned prompt overrides (ADR-0236).
 *
 * A binding is identified by its natural key (prompt, scope, target), which is
 * unique, and its revisions point at it by id. Neither the generic id-keyed
 * applier nor its "duplicate" strategy fits: two bindings for the same slot
 * cannot coexist, and revisions must move with their binding. So a binding and
 * its revisions are applied as one unit:
 *
 * - no local binding for the slot: the imported binding and revisions are
 *   added (ids re-minted only if they collide with an unrelated local row);
 * - a local binding exists: `skip` keeps it; `overwrite` and `duplicate`
 *   replace it and its history with the imported unit, the same collapse the
 *   other naturally-keyed tables apply.
 *
 * Revisions whose binding is absent from the package are dropped; a revision
 * cannot be reattached to a slot nobody named.
 */

import type { CogniaDB } from "@/lib/db/schema"
import type { PromptOverrideBindingRow, PromptOverrideRevisionRow } from "@/lib/db/prompt-overrides"
import type { ImportOptions, ImportSummary } from "./types"

const KIND = "promptOverrides"

function remint(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function bump(counter: Record<string, number>): void {
  counter[KIND] = (counter[KIND] ?? 0) + 1
}

export async function applyPromptOverrideBackup(args: {
  db: CogniaDB
  bindings: PromptOverrideBindingRow[] | undefined
  revisions: PromptOverrideRevisionRow[] | undefined
  opts: Pick<ImportOptions, "mergeStrategy">
  summary: ImportSummary
}): Promise<void> {
  const { db, opts, summary } = args
  const bindings = args.bindings ?? []
  if (bindings.length === 0) return
  const revisionsByBinding = new Map<string, PromptOverrideRevisionRow[]>()
  for (const row of args.revisions ?? []) {
    const list = revisionsByBinding.get(row.bindingId) ?? []
    list.push(row)
    revisionsByBinding.set(row.bindingId, list)
  }

  for (const imported of bindings) {
    const local = await db.promptOverrides
      .where("[promptId+scope+targetId]")
      .equals([imported.promptId, imported.scope, imported.targetId])
      .first()
    if (local && opts.mergeStrategy === "skip") {
      bump(summary.skipped)
      continue
    }
    if (local) {
      await db.promptOverrideRevisions.where("bindingId").equals(local.id).delete()
      await db.promptOverrides.delete(local.id)
    }

    const bindingId =
      (await db.promptOverrides.get(imported.id)) === undefined ? imported.id : remint("pob")
    const idMap = new Map<string, string>()
    const revisions = revisionsByBinding.get(imported.id) ?? []
    for (const row of revisions) {
      const taken = (await db.promptOverrideRevisions.get(row.id)) !== undefined
      idMap.set(row.id, taken ? remint("por") : row.id)
    }
    const mapRef = (id: string | null) => (id === null ? null : (idMap.get(id) ?? null))
    await db.promptOverrideRevisions.bulkPut(
      revisions.map((row) => ({
        ...row,
        id: idMap.get(row.id)!,
        bindingId,
        parentId: mapRef(row.parentId),
      }))
    )
    await db.promptOverrides.put({
      ...imported,
      id: bindingId,
      // A pointer at a revision the package did not carry would dangle.
      activeRevisionId: mapRef(imported.activeRevisionId),
      draftRevisionId: mapRef(imported.draftRevisionId),
    })
    bump(local ? summary.overwritten : summary.added)
  }
}
