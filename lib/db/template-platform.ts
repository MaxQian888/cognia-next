import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { TemplateTrust } from "@/lib/templates/contracts"
import type {
  SaveDraftResult,
  StoredTemplatePackage,
  TemplateDeviceBindingRecord,
  TemplateInstanceRecord,
  TemplateMigrationJournalRecord,
  TemplateRepository,
} from "@/lib/templates/repository"
import { getDb } from "./schema"

export interface TemplateDefinitionRow extends TemplateDefinitionEnvelope {
  storageKey: string
}

export interface TemplatePackageRow extends StoredTemplatePackage {
  id: string
  version: string
}

export type { TemplateDeviceBindingRecord, TemplateInstanceRecord, TemplateMigrationJournalRecord }

function draftKey(id: string): string {
  return `draft:${id}`
}

function releaseKey(id: string, version: string): string {
  return `release:${id}@${version}`
}

function toDefinition(row: TemplateDefinitionRow): TemplateDefinitionEnvelope {
  const { storageKey: _storageKey, ...definition } = row
  return definition
}

function draftRow(definition: TemplateDefinitionEnvelope): TemplateDefinitionRow {
  return { ...definition, storageKey: draftKey(definition.id) }
}

function releaseRow(definition: TemplateDefinitionEnvelope): TemplateDefinitionRow {
  if (!definition.version) throw new Error("Template release version is required")
  return { ...definition, storageKey: releaseKey(definition.id, definition.version) }
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
      await db.templateDefinitions.put(draftRow(definition))
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
      await db.templateDefinitions.add(releaseRow(definition))
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

  async putInstance(value: TemplateInstanceRecord): Promise<void> {
    await getDb().templateInstances.put(value)
  }

  async getInstance(id: string): Promise<TemplateInstanceRecord | undefined> {
    return getDb().templateInstances.get(id)
  }

  async listInstances(): Promise<TemplateInstanceRecord[]> {
    return getDb().templateInstances.toArray()
  }
}

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
