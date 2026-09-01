import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { TemplateTrust } from "@/lib/templates/contracts"
import type {
  SaveDraftResult,
  StoredTemplatePackage,
  TemplateDeviceBindingRecord,
  TemplateDerivation,
  TemplateInstanceRecord,
  TemplateLocalRecord,
  TemplateMigrationJournalRecord,
  TemplateRepository,
} from "@/lib/templates/repository"
import { getDb } from "./schema"

/**
 * A stored definition: the portable envelope plus what only this library knows.
 *
 * `workspaceId` and `derivedFrom` are local facts (see `TemplateLocalRecord`).
 * They live on the row rather than in the envelope so that `toDefinition`
 * removes them on every read, which means no export, package or content hash
 * can ever carry them. Every row sharing a definition id carries the same
 * values, so any one of them can answer a read.
 */
export interface TemplateDefinitionRow extends TemplateDefinitionEnvelope {
  storageKey: string
  workspaceId?: string
  derivedFrom?: TemplateDerivation
}

export interface TemplatePackageRow extends StoredTemplatePackage {
  id: string
  version: string
}

export type {
  TemplateDerivation,
  TemplateDeviceBindingRecord,
  TemplateInstanceRecord,
  TemplateLocalRecord,
  TemplateMigrationJournalRecord,
}

function draftKey(id: string): string {
  return `draft:${id}`
}

function releaseKey(id: string, version: string): string {
  return `release:${id}@${version}`
}

function toDefinition(row: TemplateDefinitionRow): TemplateDefinitionEnvelope {
  const {
    storageKey: _storageKey,
    workspaceId: _workspaceId,
    derivedFrom: _derivedFrom,
    ...definition
  } = row
  return definition
}

/** The local half of a row, for callers that want it. */
function toLocal(row: TemplateDefinitionRow): TemplateLocalRecord {
  const local: TemplateLocalRecord = {}
  if (row.workspaceId !== undefined) local.workspaceId = row.workspaceId
  if (row.derivedFrom !== undefined) local.derivedFrom = row.derivedFrom
  return local
}

/**
 * `local` is threaded through both row builders because a save spreads a bare
 * envelope, which has no local fields. Without it every `saveDraft` would
 * quietly erase the workspace and the fork lineage of the row it overwrites.
 */
function draftRow(
  definition: TemplateDefinitionEnvelope,
  local?: TemplateLocalRecord
): TemplateDefinitionRow {
  return { ...definition, ...local, storageKey: draftKey(definition.id) }
}

function releaseRow(
  definition: TemplateDefinitionEnvelope,
  local?: TemplateLocalRecord
): TemplateDefinitionRow {
  if (!definition.version) throw new Error("Template release version is required")
  return { ...definition, ...local, storageKey: releaseKey(definition.id, definition.version) }
}

function packageRow(value: StoredTemplatePackage): TemplatePackageRow {
  return {
    ...value,
    id: value.manifest.id,
    version: value.manifest.version,
  }
}

export class DexieTemplateRepository implements TemplateRepository {
  async listDefinitions(): Promise<TemplateDefinitionEnvelope[]> {
    return (await getDb().templateDefinitions.toArray()).map(toDefinition)
  }

  async getDraft(id: string): Promise<TemplateDefinitionEnvelope | undefined> {
    const row = await getDb().templateDefinitions.get(draftKey(id))
    return row ? toDefinition(row) : undefined
  }

  async deleteDraft(id: string): Promise<void> {
    await getDb().templateDefinitions.delete(draftKey(id))
  }

  async getRelease(id: string, version: string): Promise<TemplateDefinitionEnvelope | undefined> {
    const row = await getDb().templateDefinitions.get(releaseKey(id, version))
    return row ? toDefinition(row) : undefined
  }

  async listReleases(id: string): Promise<TemplateDefinitionEnvelope[]> {
    const rows = await getDb().templateDefinitions.where("id").equals(id).toArray()
    return rows.filter((row) => row.version !== null).map(toDefinition)
  }

  async saveDraft(
    definition: TemplateDefinitionEnvelope,
    expectedRevision: number
  ): Promise<SaveDraftResult> {
    if (definition.version !== null || !["draft", "conflict"].includes(definition.status)) {
      throw new Error("Only mutable drafts can be saved through saveDraft")
    }
    const db = getDb()
    return db.transaction("rw", db.templateDefinitions, async () => {
      const current = await db.templateDefinitions.get(draftKey(definition.id))
      if ((current?.revision ?? 0) !== expectedRevision) {
        return {
          saved: false,
          current: current ? toDefinition(current) : undefined,
        } satisfies SaveDraftResult
      }
      await db.templateDefinitions.put(draftRow(definition, current ? toLocal(current) : undefined))
      return { saved: true, definition } satisfies SaveDraftResult
    })
  }

  async putRelease(definition: TemplateDefinitionEnvelope): Promise<void> {
    if (!definition.version || !["published", "deprecated", "yanked"].includes(definition.status)) {
      throw new Error("Only versioned releases can be stored through putRelease")
    }
    const db = getDb()
    await db.transaction("rw", db.templateDefinitions, async () => {
      const key = releaseKey(definition.id, definition.version!)
      if (await db.templateDefinitions.get(key)) {
        throw new Error(`Template release ${definition.id}@${definition.version} is immutable`)
      }
      const sibling = await db.templateDefinitions.where("id").equals(definition.id).first()
      await db.templateDefinitions.add(
        releaseRow(definition, sibling ? toLocal(sibling) : undefined)
      )
    })
  }

  async setReleaseStatus(
    id: string,
    version: string,
    status: "deprecated" | "yanked",
    updatedAt: number
  ): Promise<TemplateDefinitionEnvelope> {
    const db = getDb()
    return db.transaction("rw", db.templateDefinitions, async () => {
      const key = releaseKey(id, version)
      const current = await db.templateDefinitions.get(key)
      if (!current) throw new Error(`Template release ${id}@${version} not found`)
      const next = { ...current, status, updatedAt }
      await db.templateDefinitions.put(next)
      return toDefinition(next)
    })
  }

  async putPackage(value: StoredTemplatePackage): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.templatePackages, async () => {
      const existing = await db.templatePackages.get(value.key)
      if (existing && existing.fingerprint !== value.fingerprint) {
        throw new Error(`Template package ${value.key} is immutable`)
      }
      await db.templatePackages.put(packageRow(value))
    })
  }

  async importPackage(
    value: StoredTemplatePackage,
    definitions: readonly TemplateDefinitionEnvelope[]
  ): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.templatePackages, db.templateDefinitions, async () => {
      const existingPackage = await db.templatePackages.get(value.key)
      if (existingPackage && existingPackage.fingerprint !== value.fingerprint) {
        throw new Error(`Template package ${value.key} is immutable`)
      }
      for (const definition of definitions) {
        const key = releaseKey(definition.id, definition.version!)
        const existing = await db.templateDefinitions.get(key)
        if (existing && existing.contentHash !== definition.contentHash) {
          throw new Error(`Template release ${definition.id}@${definition.version} is immutable`)
        }
      }
      await db.templatePackages.put(packageRow(value))
      await db.templateDefinitions.bulkPut(definitions.map(releaseRow))
    })
  }

  async listPackages(): Promise<StoredTemplatePackage[]> {
    return (await getDb().templatePackages.toArray()).map(
      ({ id: _id, version: _version, ...row }) => row
    )
  }

  async reconcilePackageTrust(key: string, trust: TemplateTrust): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.templatePackages, db.templateDefinitions, async () => {
      const storedPackage = await db.templatePackages.get(key)
      if (!storedPackage) throw new Error(`Template package ${key} not found`)
      await db.templatePackages.put({ ...storedPackage, trust })
      for (const identity of storedPackage.manifest.definitions) {
        const storageKey = releaseKey(identity.id, identity.version)
        const definition = await db.templateDefinitions.get(storageKey)
        if (!definition) continue
        await db.templateDefinitions.put({
          ...definition,
          provenance: { ...definition.provenance, trust },
        })
      }
    })
  }

  async removePackage(key: string): Promise<number> {
    const db = getDb()
    return db.transaction("rw", db.templatePackages, db.templateDefinitions, async () => {
      const storedPackage = await db.templatePackages.get(key)
      if (!storedPackage) throw new Error(`Template package ${key} not found`)
      let removed = 0
      for (const identity of storedPackage.manifest.definitions) {
        const storageKey = releaseKey(identity.id, identity.version)
        if (!(await db.templateDefinitions.get(storageKey))) continue
        await db.templateDefinitions.delete(storageKey)
        removed += 1
      }
      await db.templatePackages.delete(key)
      return removed
    })
  }

  async putInstance(value: TemplateInstanceRecord): Promise<void> {
    await getDb().templateInstances.put(value)
  }

  async getInstance(id: string): Promise<TemplateInstanceRecord | undefined> {
    return getDb().templateInstances.get(id)
  }

  async listInstances(scope?: { projectId: string }): Promise<TemplateInstanceRecord[]> {
    if (!scope) return getDb().templateInstances.toArray()
    // A row with no workspace is legacy, not foreign: it predates the column,
    // and dropping it here would make instances disappear before the backfill
    // reaches them. Same rule `byProjectId` uses for unowned rows.
    return (await getDb().templateInstances.toArray()).filter(
      (row) => row.projectId === undefined || row.projectId === scope.projectId
    )
  }

  async getLocal(id: string): Promise<TemplateLocalRecord | undefined> {
    const row = await getDb().templateDefinitions.where("id").equals(id).first()
    if (!row) return undefined
    const local = toLocal(row)
    return Object.keys(local).length > 0 ? local : undefined
  }

  async putLocal(id: string, patch: TemplateLocalRecord): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.templateDefinitions, async () => {
      // Every row of this id, so a read can take the first one it finds and a
      // later release does not disagree with the draft it came from.
      await db.templateDefinitions
        .where("id")
        .equals(id)
        .modify((row) => {
          for (const key of ["workspaceId", "derivedFrom"] as const) {
            if (!(key in patch)) continue
            // An explicit `undefined` is a clear: `detachDerivation` sends one.
            if (patch[key] === undefined) delete row[key]
            else Object.assign(row, { [key]: patch[key] })
          }
        })
    })
  }

  async listLocal(): Promise<Record<string, TemplateLocalRecord>> {
    const out: Record<string, TemplateLocalRecord> = {}
    for (const row of await getDb().templateDefinitions.toArray()) {
      if (out[row.id]) continue
      const local = toLocal(row)
      if (Object.keys(local).length > 0) out[row.id] = local
    }
    return out
  }
}

/**
 * Definition id to the workspace that owns it, for the definitions that have
 * one. A definition absent from this map is shared with every workspace.
 *
 * Read directly rather than through the repository because the callers are
 * Dexie live queries: they want to re-render when the row changes, and the
 * repository interface is a promise-returning port with no change signal.
 */
export async function listTemplateOwners(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const row of await getDb().templateDefinitions.toArray()) {
    if (row.workspaceId !== undefined) out[row.id] = row.workspaceId
  }
  return out
}

/**
 * Device bindings, declared and unused.
 *
 * `TemplateInstanceRecord` carries `bindings` and `bindingFingerprint` inline,
 * and every read and write goes through those, so this table has never held a
 * row. It exists for the case the inline copy cannot serve: a binding that is
 * per-DEVICE rather than per-instance, which is why it is local-only and absent
 * from `lib/sync`. Kept because dropping a declared table is a schema change
 * with a migration cost and nothing to gain, and pinned by a test so the
 * emptiness is a decision rather than something nobody noticed.
 */
export async function putTemplateDeviceBinding(
  binding: TemplateDeviceBindingRecord
): Promise<void> {
  await getDb().templateDeviceBindings.put(binding)
}

export async function listTemplateDeviceBindings(
  definitionId: string
): Promise<TemplateDeviceBindingRecord[]> {
  return getDb().templateDeviceBindings.where("definitionId").equals(definitionId).toArray()
}

export async function putTemplateMigrationJournal(
  record: TemplateMigrationJournalRecord
): Promise<void> {
  await getDb().templateMigrationJournal.put(record)
}

export async function listTemplateMigrationJournal(
  domain?: string
): Promise<TemplateMigrationJournalRecord[]> {
  if (!domain) return getDb().templateMigrationJournal.toArray()
  return getDb().templateMigrationJournal.where("domain").equals(domain).toArray()
}
