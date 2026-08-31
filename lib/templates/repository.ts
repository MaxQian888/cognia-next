import type { TemplateDefinitionEnvelope, TemplateJson, TemplateTrust } from "./contracts"
import type { TemplatePackageManifest } from "./package"

export interface StoredTemplatePackage {
  key: string
  manifest: TemplatePackageManifest
  fingerprint: string
  trust: TemplateTrust
  importedAt: number
  source: "file" | "link" | "plugin" | "marketplace"
  yankedAt?: number
}

export interface TemplateResourceRef {
  domain: string
  id: string
}

export interface TemplateInstanceRecord {
  id: string
  idempotencyKey: string
  source: {
    definitionId: string
    version: string | null
    revision: number
    status: TemplateDefinitionEnvelope["status"]
    contentHash: string
    snapshot: TemplateDefinitionEnvelope
  }
  bindingFingerprint: string
  /**
   * The non-sensitive input values this instance was created with.
   *
   * Recorded because an update has no plan of its own: without them the next
   * version's payload would be written back with its `{{inputId}}` tokens
   * un-substituted, undoing the interpolation the instance was created with.
   * Sensitive bindings are deliberately absent — see `interpolatableBindings`.
   * Absent entirely on instances created before this was recorded, which is
   * exactly the set whose payloads were never interpolated either.
   */
  bindings?: Record<string, string>
  resources: TemplateResourceRef[]
  baseline: TemplateJson
  createdAt: number
  updatedAt: number
  detachedAt?: number
  sourceUnavailableAt?: number
}

export interface TemplateDeviceBindingRecord {
  id: string
  definitionId: string
  slotId: string
  kind: "twin" | "credential" | "path" | "provider" | "resource"
  localResourceId: string
  updatedAt: number
}

export interface TemplateMigrationJournalRecord {
  id: string
  domain: string
  sourceKey: string
  status: "pending" | "completed" | "quarantined" | "rolled-back"
  sourceFingerprint?: string
  targetDefinitionId?: string
  rollbackSnapshot?: TemplateJson
  diagnostics?: string[]
  updatedAt: number
}

export type SaveDraftResult =
  | { saved: true; definition: TemplateDefinitionEnvelope }
  | { saved: false; current?: TemplateDefinitionEnvelope }

export interface TemplateRepository {
  listDefinitions(): Promise<TemplateDefinitionEnvelope[]>
  getDraft(id: string): Promise<TemplateDefinitionEnvelope | undefined>
  deleteDraft(id: string): Promise<void>
  getRelease(id: string, version: string): Promise<TemplateDefinitionEnvelope | undefined>
  listReleases(id: string): Promise<TemplateDefinitionEnvelope[]>
  saveDraft(
    definition: TemplateDefinitionEnvelope,
    expectedRevision: number
  ): Promise<SaveDraftResult>
  putRelease(definition: TemplateDefinitionEnvelope): Promise<void>
  setReleaseStatus(
    id: string,
    version: string,
    status: "deprecated" | "yanked",
    updatedAt: number
  ): Promise<TemplateDefinitionEnvelope>
  putPackage(value: StoredTemplatePackage): Promise<void>
  importPackage(
    value: StoredTemplatePackage,
    definitions: readonly TemplateDefinitionEnvelope[]
  ): Promise<void>
  reconcilePackageTrust(key: string, trust: TemplateTrust): Promise<void>
  /**
   * Delete a package row and the releases its manifest brought in.
   *
   * Scoped to the manifest's own `{id, version}` identities rather than to
   * `provenance.packageId`, because two versions of the same package share that
   * id and removing one must not take the other's releases with it. A release
   * another package also carries stays, which is why the count comes back.
   */
  removePackage(key: string): Promise<number>
  listPackages(): Promise<StoredTemplatePackage[]>
  putInstance(value: TemplateInstanceRecord): Promise<void>
  getInstance(id: string): Promise<TemplateInstanceRecord | undefined>
  listInstances(): Promise<TemplateInstanceRecord[]>
}

function releaseKey(id: string, version: string): string {
  return `${id}@${version}`
}

export class InMemoryTemplateRepository implements TemplateRepository {
  private readonly drafts = new Map<string, TemplateDefinitionEnvelope>()
  private readonly releases = new Map<string, TemplateDefinitionEnvelope>()
  private readonly packages = new Map<string, StoredTemplatePackage>()
  private readonly instances = new Map<string, TemplateInstanceRecord>()

  async listDefinitions(): Promise<TemplateDefinitionEnvelope[]> {
    return [...this.drafts.values(), ...this.releases.values()].map((value) =>
      structuredClone(value)
    )
  }

  async getDraft(id: string): Promise<TemplateDefinitionEnvelope | undefined> {
    const value = this.drafts.get(id)
    return value ? structuredClone(value) : undefined
  }

  async deleteDraft(id: string): Promise<void> {
    this.drafts.delete(id)
  }

  async getRelease(id: string, version: string): Promise<TemplateDefinitionEnvelope | undefined> {
    const value = this.releases.get(releaseKey(id, version))
    return value ? structuredClone(value) : undefined
  }

  async listReleases(id: string): Promise<TemplateDefinitionEnvelope[]> {
    return [...this.releases.values()]
      .filter((definition) => definition.id === id)
      .map((value) => structuredClone(value))
  }

  async saveDraft(
    definition: TemplateDefinitionEnvelope,
    expectedRevision: number
  ): Promise<SaveDraftResult> {
    if (definition.version !== null || !["draft", "conflict"].includes(definition.status)) {
      throw new Error("Only mutable drafts can be saved through saveDraft")
    }
    const current = this.drafts.get(definition.id)
    if ((current?.revision ?? 0) !== expectedRevision) {
      return { saved: false, current: current ? structuredClone(current) : undefined }
    }
    this.drafts.set(definition.id, structuredClone(definition))
    return { saved: true, definition: structuredClone(definition) }
  }

  async putRelease(definition: TemplateDefinitionEnvelope): Promise<void> {
    if (!definition.version || !["published", "deprecated", "yanked"].includes(definition.status)) {
      throw new Error("Only versioned releases can be stored through putRelease")
    }
    const key = releaseKey(definition.id, definition.version)
    if (this.releases.has(key)) {
      throw new Error(`Template release ${key} is immutable and already exists`)
    }
    this.releases.set(key, structuredClone(definition))
  }

  async setReleaseStatus(
    id: string,
    version: string,
    status: "deprecated" | "yanked",
    updatedAt: number
  ): Promise<TemplateDefinitionEnvelope> {
    const key = releaseKey(id, version)
    const current = this.releases.get(key)
    if (!current) throw new Error(`Template release ${key} not found`)
    const next = { ...current, status, updatedAt }
    this.releases.set(key, structuredClone(next))
    return structuredClone(next)
  }

  async putPackage(value: StoredTemplatePackage): Promise<void> {
    const existing = this.packages.get(value.key)
    if (existing && existing.fingerprint !== value.fingerprint) {
      throw new Error(`Template package ${value.key} is immutable and already exists`)
    }
    this.packages.set(value.key, structuredClone(value))
  }

  async importPackage(
    value: StoredTemplatePackage,
    definitions: readonly TemplateDefinitionEnvelope[]
  ): Promise<void> {
    const existingPackage = this.packages.get(value.key)
    if (existingPackage && existingPackage.fingerprint !== value.fingerprint) {
      throw new Error(`Template package ${value.key} is immutable and already exists`)
    }
    for (const definition of definitions) {
      const key = releaseKey(definition.id, definition.version!)
      const existing = this.releases.get(key)
      if (existing && existing.contentHash !== definition.contentHash) {
        throw new Error(`Template release ${key} is immutable and already exists`)
      }
    }
    this.packages.set(value.key, structuredClone(value))
    for (const definition of definitions) {
      this.releases.set(releaseKey(definition.id, definition.version!), structuredClone(definition))
    }
  }

  async listPackages(): Promise<StoredTemplatePackage[]> {
    return [...this.packages.values()].map((value) => structuredClone(value))
  }

  async reconcilePackageTrust(key: string, trust: TemplateTrust): Promise<void> {
    const storedPackage = this.packages.get(key)
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    this.packages.set(key, structuredClone({ ...storedPackage, trust }))
    for (const identity of storedPackage.manifest.definitions) {
      const key = releaseKey(identity.id, identity.version)
      const definition = this.releases.get(key)
      if (!definition) continue
      this.releases.set(
        key,
        structuredClone({
          ...definition,
          provenance: { ...definition.provenance, trust },
        })
      )
    }
  }

  async removePackage(key: string): Promise<number> {
    const storedPackage = this.packages.get(key)
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    this.packages.delete(key)
    let removed = 0
    for (const identity of storedPackage.manifest.definitions) {
      if (this.releases.delete(releaseKey(identity.id, identity.version))) removed += 1
    }
    return removed
  }

  async putInstance(value: TemplateInstanceRecord): Promise<void> {
    this.instances.set(value.id, structuredClone(value))
  }

  async getInstance(id: string): Promise<TemplateInstanceRecord | undefined> {
    const value = this.instances.get(id)
    return value ? structuredClone(value) : undefined
  }

  async listInstances(): Promise<TemplateInstanceRecord[]> {
    return [...this.instances.values()].map((value) => structuredClone(value))
  }
}
