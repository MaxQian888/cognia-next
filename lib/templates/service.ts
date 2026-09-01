import { sha256Hex } from "@/lib/share/hash"
import { TemplateCatalog } from "./catalog"
import { interpolatableBindings, resolvedUpdatePayload } from "./adapters"
import { mergePayload } from "./payload-diff"
import {
  canonicalTemplateStringify,
  createTemplateDefinition,
  incrementTemplateVersion,
  suggestTemplateVersionBump,
  validateTemplateDefinition,
  verifyTemplateDefinitionHash,
  type TemplateCompatibility,
  type TemplateDefinitionEnvelope,
  type TemplateDependency,
  type TemplateDomain,
  type TemplateInputSpec,
  type TemplateJson,
  type TemplateMetadata,
  type TemplatePlatform,
  type TemplateValidationIssue,
  type TemplateVersionBump,
  type TemplateTrust,
} from "./contracts"
import {
  exportTemplatePackage,
  inspectTemplatePackage,
  type ExportedTemplatePackage,
  type InspectedTemplatePackage,
} from "./package"
import type {
  StoredTemplatePackage,
  TemplateInstanceRecord,
  TemplateRepository,
  TemplateResourceRef,
} from "./repository"

export interface TemplateBinding {
  slotId: string
  kind: string
  resourceId: string
  sensitive?: boolean
}

export interface TemplatePreflightIssue {
  code: string
  severity: "blocker" | "warning"
  message: string
  path?: string
}

export interface TemplateOperation {
  id: string
  kind: "create" | "update" | "bind" | "permission" | "enable"
  domain: string
  summary: string
  sideEffects?: string[]
}

export interface TemplatePreflightPlan {
  id?: string
  definitionId: string
  definitionHash: string
  definition?: TemplateDefinitionEnvelope
  platform?: TemplatePlatform
  status: "ready" | "needs-confirmation" | "blocked"
  bindings: TemplateBinding[]
  issues: TemplatePreflightIssue[]
  operations: TemplateOperation[]
  requiresConfirmation: boolean
}

/** What `TemplateService.verifyPackage` can still establish without the bytes. */
export interface TemplatePackageVerification {
  key: string
  trust: TemplateTrust
  /** Whether the manifest carried a signature at import time. */
  signed: boolean
  definitions: Array<{
    id: string
    version: string
    state: "verified" | "missing" | "hash-mismatch"
  }>
}

export interface TemplateInstantiationResult {
  resources: TemplateResourceRef[]
  rollbackToken?: TemplateJson | null
}

export interface TemplateDiffResult {
  changes: Array<{ path: string; before?: TemplateJson; after?: TemplateJson }>
  conflicts: Array<{
    path: string
    baseline?: TemplateJson
    local?: TemplateJson
    next?: TemplateJson
  }>
}

/** Which side of a conflicting path wins when an update is applied. */
export type TemplateConflictResolution = "local" | "upstream"

export interface TemplateUpdatePlan {
  id: string
  instanceId: string
  source: TemplateDefinitionEnvelope
  next: TemplateDefinitionEnvelope
  diff: TemplateDiffResult
  status: "ready" | "needs-confirmation" | "blocked"
  issues: TemplatePreflightIssue[]
}

export interface TemplateDomainAdapter {
  domain: TemplateDomain
  project(resource: unknown): Promise<TemplateJson>
  validate(definition: TemplateDefinitionEnvelope): TemplateValidationIssue[]
  preflight(input: {
    definition: TemplateDefinitionEnvelope
    platform: TemplatePlatform
    bindings: Record<string, string>
  }): Promise<TemplatePreflightPlan>
  instantiate(input: {
    definition: TemplateDefinitionEnvelope
    plan: TemplatePreflightPlan
    idempotencyKey: string
  }): Promise<TemplateInstantiationResult>
  snapshot(resourceIds: TemplateResourceRef[]): Promise<TemplateJson>
  diff(baseline: TemplateJson, local: TemplateJson, next: TemplateJson): TemplateDiffResult
  update(input: {
    instance: TemplateInstanceRecord
    next: TemplateDefinitionEnvelope
    diff: TemplateDiffResult
    /**
     * What to actually write: the local resource with the upstream changes
     * folded in, and with the conflicts the user chose to adopt taken from
     * `next`. Absent when there was nothing to reconcile, in which case an
     * adapter falls back to `resolvedUpdatePayload(next, instance)`.
     *
     * Without this the adopt-set could not reach the adapter at all: both
     * implementations ignored `diff` and wrote the whole of `next`, so a
     * partial resolution would have been silently discarded.
     */
    resolvedPayload?: TemplateJson
    idempotencyKey: string
  }): Promise<TemplateInstantiationResult>
  rollback?(token: TemplateJson): Promise<void>
  isActive?(resourceIds: TemplateResourceRef[]): Promise<boolean>
}

export interface CreateTemplateDraftInput<TPayload extends TemplateJson = TemplateJson> {
  id: string
  domain: TemplateDomain
  metadata: TemplateMetadata
  payload: TPayload
  inputs: TemplateInputSpec[]
  dependencies: TemplateDependency[]
  capabilities: string[]
  compatibility: TemplateCompatibility
}

export interface TemplateServiceOptions {
  repository: TemplateRepository
  catalog: TemplateCatalog
  adapters: TemplateDomainAdapter[]
  now?: () => number
  id?: () => string
  hostVersion?: string
  rollbackMigration?: (domain: TemplateDomain) => Promise<number>
  isPublisherTrusted?: (publicKey: string) => Promise<boolean>
}

function compareSemver(left: string, right: string): number {
  const l = left.split(/[+-]/, 1)[0].split(".").map(Number)
  const r = right.split(/[+-]/, 1)[0].split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (l[index] !== r[index]) return l[index] - r[index]
  }
  return 0
}

export class TemplateService {
  private readonly repository: TemplateRepository
  private readonly catalog: TemplateCatalog
  private readonly adapters: Map<TemplateDomain, TemplateDomainAdapter>
  private readonly now: () => number
  private readonly id: () => string
  private readonly hostVersion: string
  private readonly rollbackMigrationHandler?: (domain: TemplateDomain) => Promise<number>
  private readonly isPublisherTrusted: (publicKey: string) => Promise<boolean>

  constructor(options: TemplateServiceOptions) {
    this.repository = options.repository
    this.catalog = options.catalog
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.domain, adapter]))
    this.now = options.now ?? Date.now
    this.id = options.id ?? (() => crypto.randomUUID())
    this.hostVersion = options.hostVersion ?? process.env.NEXT_PUBLIC_COGNIA_VERSION ?? "0.1.0"
    this.rollbackMigrationHandler = options.rollbackMigration
    this.isPublisherTrusted = options.isPublisherTrusted ?? (async () => false)
  }

  async hydrateCatalog(): Promise<void> {
    for (const storedPackage of await this.repository.listPackages()) {
      await this.repository.reconcilePackageTrust(
        storedPackage.key,
        await this.resolvePackageTrust(storedPackage.manifest.signature?.publicKey)
      )
    }
    this.catalog.replaceSource("user", await this.repository.listDefinitions())
  }

  private async resolvePackageTrust(publicKey?: string): Promise<TemplateTrust> {
    if (!publicKey) return "unsigned"
    return (await this.isPublisherTrusted(publicKey)) ? "verified-publisher" : "signed-unknown"
  }

  async rollbackMigration(domain: TemplateDomain): Promise<number> {
    if (!this.rollbackMigrationHandler) {
      throw new Error("Template migration rollback is unavailable in this runtime")
    }
    const count = await this.rollbackMigrationHandler(domain)
    await this.hydrateCatalog()
    return count
  }

  async createDraft<TPayload extends TemplateJson>(
    input: CreateTemplateDraftInput<TPayload>
  ): Promise<TemplateDefinitionEnvelope<TPayload>> {
    const definition = await createTemplateDefinition({
      ...input,
      status: "draft",
      revision: 1,
      version: null,
      provenance: { source: "user", trust: "unsigned" },
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    const validation = this.validate(definition)
    if (!validation.ok) {
      throw new Error(
        `Template draft is invalid: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      )
    }
    const saved = await this.repository.saveDraft(definition, 0)
    if (!saved.saved) throw new Error(`Template draft ${input.id} already exists`)
    this.catalog.upsert("user", definition)
    return definition
  }

  async fork(
    definitionId: string,
    input: { version?: string; newId: string }
  ): Promise<TemplateDefinitionEnvelope> {
    const source = input.version
      ? await this.repository.getRelease(definitionId, input.version)
      : await this.repository.getDraft(definitionId)
    if (!source) throw new Error(`Template definition ${definitionId} not found`)
    return this.createDraft({
      id: input.newId,
      domain: source.domain,
      metadata: { ...source.metadata, name: `${source.metadata.name} Copy` },
      payload: structuredClone(source.payload),
      inputs: structuredClone(source.inputs),
      dependencies: structuredClone(source.dependencies),
      capabilities: [...source.capabilities],
      compatibility: structuredClone(source.compatibility),
    })
  }

  /**
   * The bump `publish` will accept, with the reasons behind it and the two
   * versions they sit between.
   *
   * `currentVersion` / `nextVersion` are returned rather than left to the
   * caller because the comparison that finds the latest release lives here:
   * a UI that re-derived them would need its own semver ordering, and the
   * point of this method is that the confirmation shows the same numbers
   * `publish` is about to use.
   */
  async getPublishSuggestion(id: string): Promise<{
    bump: TemplateVersionBump
    reasons: string[]
    currentVersion: string | null
    nextVersion: string
  }> {
    const draft = await this.repository.getDraft(id)
    if (!draft) throw new Error(`Template draft ${id} not found`)
    const releases = (await this.repository.listReleases(id)).sort((a, b) =>
      compareSemver(b.version!, a.version!)
    )
    const previous = releases[0]
    const suggestion = previous
      ? suggestTemplateVersionBump(previous, draft)
      : { bump: "minor" as const, reasons: ["Initial release"] }
    return {
      ...suggestion,
      currentVersion: previous?.version ?? null,
      nextVersion: incrementTemplateVersion(previous?.version ?? "0.0.0", suggestion.bump),
    }
  }

  async saveDraft(
    input: TemplateDefinitionEnvelope,
    expectedRevision: number
  ): Promise<TemplateDefinitionEnvelope> {
    const current = await this.repository.getDraft(input.id)
    if (!current || current.revision !== expectedRevision) {
      return this.saveConflictDraft(input, current)
    }
    const next = await createTemplateDefinition({
      ...input,
      status: input.status === "conflict" ? "conflict" : "draft",
      revision: expectedRevision + 1,
      version: null,
      baselineHash: input.baselineHash ?? current.baselineHash,
      contentHash: undefined,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    })
    const validation = this.validate(next)
    if (!validation.ok) {
      throw new Error(
        `Template draft is invalid: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      )
    }
    const saved = await this.repository.saveDraft(next, expectedRevision)
    if (!saved.saved) return this.saveConflictDraft(input, saved.current)
    this.catalog.upsert("user", next)
    return next
  }

  private async saveConflictDraft(
    input: TemplateDefinitionEnvelope,
    current?: TemplateDefinitionEnvelope
  ): Promise<TemplateDefinitionEnvelope> {
    const conflict = await createTemplateDefinition({
      ...input,
      id: `${input.id}.conflict.${this.id()}`,
      status: "conflict",
      revision: 1,
      version: null,
      baselineHash: current?.contentHash ?? input.baselineHash,
      contentHash: undefined,
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    const saved = await this.repository.saveDraft(conflict, 0)
    if (!saved.saved) throw new Error(`Conflict draft ${conflict.id} already exists`)
    this.catalog.upsert("user", conflict)
    return conflict
  }

  validate(definition: TemplateDefinitionEnvelope): {
    ok: boolean
    issues: TemplateValidationIssue[]
  } {
    const base = validateTemplateDefinition(definition)
    const adapter = this.adapters.get(definition.domain)
    const adapterIssues = adapter?.validate(definition) ?? []
    const issues = [...base.issues, ...adapterIssues]
    return { ok: issues.every((issue) => issue.severity !== "error"), issues }
  }

  async publish(
    id: string,
    input: { expectedRevision: number; confirmedBump: TemplateVersionBump }
    // A release always carries a version, unlike the draft it came from. Saying
    // so here rather than returning the general envelope keeps callers from
    // having to re-check — or paper over — a field publication guarantees.
  ): Promise<TemplateDefinitionEnvelope & { version: string }> {
    const draft = await this.repository.getDraft(id)
    if (!draft) throw new Error(`Template draft ${id} not found`)
    if (draft.revision !== input.expectedRevision) {
      throw new Error(`Template draft ${id} changed before publication`)
    }
    const releases = (await this.repository.listReleases(id)).sort((a, b) =>
      compareSemver(b.version!, a.version!)
    )
    const previous = releases[0]
    const suggestion = previous
      ? suggestTemplateVersionBump(previous, draft)
      : { bump: "minor" as const, reasons: ["Initial release"] }
    if (input.confirmedBump !== suggestion.bump) {
      throw new Error(
        `Confirmed ${input.confirmedBump} bump does not match the conservative ${suggestion.bump} suggestion: ${suggestion.reasons.join("; ")}`
      )
    }
    const version = incrementTemplateVersion(previous?.version ?? "0.0.0", input.confirmedBump)
    const release = await createTemplateDefinition({
      ...draft,
      status: "published",
      version,
      revision: 1,
      baselineHash: previous?.contentHash,
      contentHash: undefined,
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    const published = { ...release, version }
    const validation = this.validate(published)
    if (!validation.ok) {
      throw new Error(
        `Template release is invalid: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      )
    }
    await this.repository.putRelease(published)
    this.catalog.upsert("user", published)
    return published
  }

  async deprecate(
    id: string,
    version: string,
    status: "deprecated" | "yanked" = "deprecated"
  ): Promise<TemplateDefinitionEnvelope> {
    const release = await this.repository.setReleaseStatus(id, version, status, this.now())
    this.catalog.upsert("user", release)
    return release
  }

  async inspectPackage(bytes: Uint8Array): Promise<InspectedTemplatePackage> {
    return inspectTemplatePackage(bytes)
  }

  /**
   * Bundle one or more releases into a portable package.
   *
   * `description` and `compatibility` are on the manifest format and were the
   * two fields the Studio's single caller never filled in, so every exported
   * package arrived nameless beyond its title and claimed no platform range at
   * all. `definitionIds` has always accepted a list, and the format allows 256
   * of them.
   */
  async exportPackage(input: {
    id: string
    version: string
    name: string
    description?: string
    compatibility?: TemplateCompatibility
    definitionIds: Array<{ id: string; version: string }>
  }): Promise<ExportedTemplatePackage> {
    if (input.definitionIds.length === 0) {
      throw new Error("Template package export needs at least one release")
    }
    const definitions: TemplateDefinitionEnvelope[] = []
    for (const identity of input.definitionIds) {
      const definition = await this.repository.getRelease(identity.id, identity.version)
      if (!definition) {
        throw new Error(`Template release ${identity.id}@${identity.version} not found`)
      }
      definitions.push(definition)
    }
    return exportTemplatePackage({
      id: input.id,
      version: input.version,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.compatibility
        ? {
            compatibility: {
              platforms: [...input.compatibility.platforms],
              ...(input.compatibility.minHostVersion
                ? { minHostVersion: input.compatibility.minHostVersion }
                : {}),
              ...(input.compatibility.maxHostVersion
                ? { maxHostVersion: input.compatibility.maxHostVersion }
                : {}),
            },
          }
        : {}),
      entrypoints: definitions.map((definition) => definition.id),
      definitions,
    })
  }

  /**
   * Re-check an imported package without its bytes.
   *
   * The repository stores the manifest, the fingerprint and the definitions,
   * not the zip, so the signature itself cannot be re-verified here. What can
   * be re-checked is the pair that actually drifts: publisher trust, which
   * flips from `signed-unknown` to `verified-publisher` the moment the user
   * accepts that key elsewhere, and each stored release's own content hash,
   * which catches a definition row that no longer hashes to what it claims.
   */
  async verifyPackage(key: string): Promise<TemplatePackageVerification> {
    const storedPackage = (await this.repository.listPackages()).find(
      (candidate) => candidate.key === key
    )
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    const trust = await this.resolvePackageTrust(storedPackage.manifest.signature?.publicKey)
    await this.repository.reconcilePackageTrust(key, trust)
    const definitions: TemplatePackageVerification["definitions"] = []
    for (const identity of storedPackage.manifest.definitions) {
      const release = await this.repository.getRelease(identity.id, identity.version)
      definitions.push({
        id: identity.id,
        version: identity.version,
        state: !release
          ? "missing"
          : (await verifyTemplateDefinitionHash(release))
            ? "verified"
            : "hash-mismatch",
      })
    }
    this.catalog.replaceSource("user", await this.repository.listDefinitions())
    return {
      key,
      trust,
      signed: Boolean(storedPackage.manifest.signature),
      definitions,
    }
  }

  /**
   * Withdraw a package without deleting it.
   *
   * `StoredTemplatePackage.yankedAt` has been on the record type since the
   * table was added and nothing ever set it. Yanking is the reversible half of
   * `removePackage`: the releases stay installed, so anything already
   * instantiated from them keeps working, and the row carries the mark that
   * says not to build anything new on it.
   */
  async yankPackage(key: string, yanked: boolean): Promise<StoredTemplatePackage> {
    const storedPackage = (await this.repository.listPackages()).find(
      (candidate) => candidate.key === key
    )
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    const next: StoredTemplatePackage = yanked
      ? { ...storedPackage, yankedAt: storedPackage.yankedAt ?? this.now() }
      : (({ yankedAt: _yankedAt, ...rest }) => rest)(storedPackage)
    await this.repository.putPackage(next)
    return next
  }

  /**
   * Uninstall a package and the releases it brought.
   *
   * Instances built from those releases are not destroyed. They are marked
   * `sourceUnavailableAt`, the same state `tombstoneCatalogSource` puts a
   * plugin's instances into when the plugin goes away, so the instance card can
   * offer to rebind rather than the row simply becoming a mystery.
   */
  async removePackage(key: string): Promise<{ definitions: number; instances: number }> {
    const storedPackage = (await this.repository.listPackages()).find(
      (candidate) => candidate.key === key
    )
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    const orphanedIds = new Set(storedPackage.manifest.definitions.map((entry) => entry.id))
    const definitions = await this.repository.removePackage(key)
    let instances = 0
    for (const instance of await this.repository.listInstances()) {
      if (!orphanedIds.has(instance.source.definitionId)) continue
      if (instance.sourceUnavailableAt) continue
      await this.repository.putInstance({
        ...instance,
        sourceUnavailableAt: this.now(),
        updatedAt: this.now(),
      })
      instances += 1
    }
    await this.hydrateCatalog()
    return { definitions, instances }
  }

  /**
   * Rebuild the package bytes from what the repository still holds.
   *
   * The signature cannot come back with them: the private key never entered
   * this app, so a re-export is always unsigned even when the original was
   * signed. Callers say so before handing the file over.
   */
  async reexportPackage(key: string): Promise<ExportedTemplatePackage> {
    const storedPackage = (await this.repository.listPackages()).find(
      (candidate) => candidate.key === key
    )
    if (!storedPackage) throw new Error(`Template package ${key} not found`)
    const manifest = storedPackage.manifest
    return this.exportPackage({
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.compatibility?.platforms
        ? {
            compatibility: {
              platforms: [...manifest.compatibility.platforms],
              ...(manifest.compatibility.minHostVersion
                ? { minHostVersion: manifest.compatibility.minHostVersion }
                : {}),
              ...(manifest.compatibility.maxHostVersion
                ? { maxHostVersion: manifest.compatibility.maxHostVersion }
                : {}),
            },
          }
        : {}),
      definitionIds: manifest.definitions.map((entry) => ({
        id: entry.id,
        version: entry.version,
      })),
    })
  }

  /**
   * Delete a draft outright.
   *
   * `repository.deleteDraft` existed for the migration rollback path only, so a
   * draft created by mistake, or a conflict draft a clashing save forked off,
   * could be edited forever but never removed. Releases are deliberately not
   * reachable from here: a published version is immutable by construction and
   * `deprecate` is the way to withdraw one.
   */
  async deleteDraft(id: string): Promise<void> {
    const draft = await this.repository.getDraft(id)
    if (!draft) throw new Error(`Template draft ${id} not found`)
    await this.repository.deleteDraft(id)
    await this.hydrateCatalog()
  }

  async importPackage(
    bytes: Uint8Array,
    input: { source: "file" | "link" | "plugin" | "marketplace"; confirmed: boolean }
  ): Promise<InspectedTemplatePackage> {
    const inspected = await inspectTemplatePackage(bytes)
    if (!input.confirmed) throw new Error("Template package import requires explicit confirmation")
    const importedAt = this.now()
    const trust = await this.resolvePackageTrust(inspected.manifest.signature?.publicKey)
    const storedPackage = {
      key: `${inspected.manifest.id}@${inspected.manifest.version}`,
      manifest: inspected.manifest,
      fingerprint: inspected.fingerprint,
      trust,
      importedAt,
      source: input.source,
    } as const
    const definitions = await Promise.all(
      inspected.definitions.map((definition) =>
        createTemplateDefinition({
          ...definition,
          baselineHash: definition.baselineHash ?? definition.contentHash,
          provenance: {
            ...definition.provenance,
            source: input.source === "marketplace" ? "marketplace" : input.source,
            packageId: inspected.manifest.id,
            trust,
            signatureFingerprint: inspected.fingerprint,
          },
        })
      )
    )
    await this.repository.importPackage(storedPackage, definitions)
    await this.hydrateCatalog()
    return inspected
  }

  async preflight(input: {
    definitionId: string
    version?: string
    platform: TemplatePlatform
    bindings: Record<string, string>
  }): Promise<TemplatePreflightPlan> {
    const definition = input.version
      ? ((await this.repository.getRelease(input.definitionId, input.version)) ??
        this.catalog.get(input.definitionId, input.version))
      : ((await this.repository.getDraft(input.definitionId)) ??
        this.catalog.get(input.definitionId))
    if (!definition) throw new Error(`Template definition ${input.definitionId} not found`)
    if (definition.status === "yanked" || definition.status === "tombstone") {
      return {
        definitionId: definition.id,
        definitionHash: definition.contentHash,
        definition,
        platform: input.platform,
        status: "blocked",
        bindings: [],
        issues: [
          {
            code: "source.unavailable",
            severity: "blocker",
            message: "Template source is unavailable",
          },
        ],
        operations: [],
        requiresConfirmation: false,
      }
    }
    if (!definition.compatibility.platforms.includes(input.platform)) {
      return {
        definitionId: definition.id,
        definitionHash: definition.contentHash,
        definition,
        platform: input.platform,
        status: "blocked",
        bindings: [],
        issues: [
          {
            code: "platform.unsupported",
            severity: "blocker",
            message: `Template is not compatible with ${input.platform}`,
          },
        ],
        operations: [],
        requiresConfirmation: false,
      }
    }
    const minHostVersion = definition.compatibility.minHostVersion
    const maxHostVersion = definition.compatibility.maxHostVersion
    if (
      (minHostVersion && compareSemver(this.hostVersion, minHostVersion) < 0) ||
      (maxHostVersion && compareSemver(this.hostVersion, maxHostVersion) > 0)
    ) {
      const requiredRange = [
        minHostVersion ? `>=${minHostVersion}` : "",
        maxHostVersion ? `<=${maxHostVersion}` : "",
      ]
        .filter(Boolean)
        .join(" and ")
      return {
        definitionId: definition.id,
        definitionHash: definition.contentHash,
        definition,
        platform: input.platform,
        status: "blocked",
        bindings: [],
        issues: [
          {
            code: "host-version.unsupported",
            severity: "blocker",
            message: `Template requires host ${requiredRange}; current host is ${this.hostVersion}`,
          },
        ],
        operations: [],
        requiresConfirmation: false,
      }
    }
    const adapter = this.adapters.get(definition.domain)
    if (!adapter) throw new Error(`Template domain ${definition.domain} is catalog-only`)
    const dependencyIssues: TemplatePreflightIssue[] = []
    for (const dependency of definition.dependencies) {
      const resolved =
        dependency.kind === "template"
          ? Boolean(
              (dependency.version &&
                (await this.repository.getRelease(dependency.id, dependency.version))) ||
              this.catalog.get(dependency.id, dependency.version)
            )
          : Boolean(input.bindings[dependency.id])
      if (resolved) continue
      dependencyIssues.push({
        code:
          dependency.requirement === "required"
            ? "dependency.required-missing"
            : "dependency.optional-fallback",
        severity: dependency.requirement === "required" ? "blocker" : "warning",
        message:
          dependency.requirement === "required"
            ? `Required dependency ${dependency.id} is unavailable`
            : `Optional dependency ${dependency.id} will use ${dependency.fallback} fallback`,
      })
    }
    const plan = await adapter.preflight({
      definition,
      platform: input.platform,
      bindings: input.bindings,
    })
    const issues = [...dependencyIssues, ...plan.issues]
    const blocked = issues.some((issue) => issue.severity === "blocker")
    return {
      ...plan,
      id: plan.id ?? this.id(),
      definitionId: definition.id,
      definitionHash: definition.contentHash,
      definition,
      platform: input.platform,
      issues,
      status: blocked ? "blocked" : plan.status,
      requiresConfirmation: blocked ? false : plan.requiresConfirmation,
    }
  }

  async instantiate(input: {
    plan: TemplatePreflightPlan
    confirmed: boolean
  }): Promise<TemplateInstantiationResult> {
    if (input.plan.status === "blocked") throw new Error("Blocked template plan cannot instantiate")
    if (input.plan.requiresConfirmation && !input.confirmed) {
      throw new Error("Template instantiation requires explicit confirmation")
    }
    const definition = input.plan.definition
    if (!definition || definition.contentHash !== input.plan.definitionHash) {
      throw new Error("Template preflight source snapshot is missing or changed")
    }
    const adapter = this.adapters.get(definition.domain)
    if (!adapter) throw new Error(`Template domain ${definition.domain} is catalog-only`)
    const idempotencyKey = input.plan.id ?? this.id()
    const existing = (await this.repository.listInstances()).find(
      (instance) => instance.idempotencyKey === idempotencyKey
    )
    if (existing) {
      return { resources: existing.resources, rollbackToken: null }
    }
    let result: TemplateInstantiationResult
    try {
      result = await adapter.instantiate({ definition, plan: input.plan, idempotencyKey })
    } catch (error) {
      throw new Error(
        `Template instantiation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const bindingFingerprint = await sha256Hex(
      canonicalTemplateStringify(input.plan.bindings as unknown as TemplateJson)
    )
    const now = this.now()
    const instance: TemplateInstanceRecord = {
      id: this.id(),
      idempotencyKey,
      source: {
        definitionId: definition.id,
        version: definition.version,
        revision: definition.revision,
        status: definition.status,
        contentHash: definition.contentHash,
        snapshot: definition,
      },
      bindingFingerprint,
      bindings: interpolatableBindings(input.plan.bindings),
      resources: result.resources,
      baseline: await adapter.snapshot(result.resources),
      createdAt: now,
      updatedAt: now,
    }
    await this.repository.putInstance(instance)
    return result
  }

  async planUpdate(instanceId: string, nextVersion: string): Promise<TemplateUpdatePlan> {
    const instance = await this.repository.getInstance(instanceId)
    if (!instance) throw new Error(`Template instance ${instanceId} not found`)
    if (instance.detachedAt) throw new Error(`Template instance ${instanceId} is detached`)
    const next = await this.repository.getRelease(instance.source.definitionId, nextVersion)
    if (!next) {
      throw new Error(`Template release ${instance.source.definitionId}@${nextVersion} not found`)
    }
    if (next.status === "yanked") {
      throw new Error(`Template release ${next.id}@${nextVersion} is yanked`)
    }
    if (next.domain !== instance.source.snapshot.domain) {
      throw new Error("Template instance cannot be rebound across domains")
    }
    const adapter = this.adapters.get(next.domain)
    if (!adapter) throw new Error(`Template domain ${next.domain} is catalog-only`)
    const active = adapter.isActive ? await adapter.isActive(instance.resources) : false
    const local = await adapter.snapshot(instance.resources)
    // Diff the payload as it WOULD be written, not as it is stored: comparing an
    // interpolated live resource against a payload still full of `{{inputId}}`
    // reports every parameterised field as a conflict.
    const diff = adapter.diff(instance.baseline, local, resolvedUpdatePayload(next, instance))
    const issues: TemplatePreflightIssue[] = []
    if (active) {
      issues.push({
        code: "instance.active",
        severity: "blocker",
        message: "Active or running resources cannot be updated",
      })
    }
    // A conflict is a question, not a wall. It used to be a blocker, which,
    // combined with a whole-document diff, meant a customised instance could
    // never take an upstream release again. Per-path conflicts are answerable,
    // so they downgrade to a warning and `applyUpdate` requires the caller to
    // have answered every one of them.
    if (diff.conflicts.length > 0) {
      issues.push({
        code: "update.conflict",
        severity: "warning",
        message: "The instance and source both changed in conflicting ways",
      })
    }
    return {
      id: this.id(),
      instanceId,
      source: instance.source.snapshot,
      next,
      diff,
      status: issues.some((issue) => issue.severity === "blocker")
        ? "blocked"
        : "needs-confirmation",
      issues,
    }
  }

  /**
   * Apply a planned update.
   *
   * `resolutions` answers every conflict the plan reported, by path. Silence
   * is refused rather than defaulted: "keep local" and "take upstream" each
   * discard someone's work, so a caller that never rendered the conflicts must
   * not be able to pick one of them by omission.
   */
  async applyUpdate(
    plan: TemplateUpdatePlan,
    input: { confirmed: boolean; resolutions?: Record<string, TemplateConflictResolution> }
  ): Promise<TemplateInstantiationResult> {
    if (plan.status === "blocked") throw new Error("Blocked template update cannot be applied")
    if (!input.confirmed) throw new Error("Template update requires explicit confirmation")
    const resolutions = input.resolutions ?? {}
    const unanswered = plan.diff.conflicts
      .map((conflict) => conflict.path)
      .filter((path) => resolutions[path] === undefined)
    if (unanswered.length > 0) {
      throw new Error(`Template update has unresolved conflicts: ${unanswered.join(", ")}`)
    }
    const adopt = Object.entries(resolutions)
      .filter(([, choice]) => choice === "upstream")
      .map(([path]) => path)
    const instance = await this.repository.getInstance(plan.instanceId)
    if (!instance || instance.detachedAt) {
      throw new Error(`Template instance ${plan.instanceId} is unavailable`)
    }
    if (instance.source.contentHash !== plan.source.contentHash) {
      throw new Error("Template instance source changed after update planning")
    }
    const adapter = this.adapters.get(plan.next.domain)
    if (!adapter) throw new Error(`Template domain ${plan.next.domain} is catalog-only`)
    if (adapter.isActive && (await adapter.isActive(instance.resources))) {
      throw new Error("Active or running resources cannot be updated")
    }
    const result = await adapter.update({
      instance,
      next: plan.next,
      diff: plan.diff,
      resolvedPayload: mergePayload(
        instance.baseline,
        await adapter.snapshot(instance.resources),
        resolvedUpdatePayload(plan.next, instance),
        adopt
      ),
      idempotencyKey: plan.id,
    })
    const updated: TemplateInstanceRecord = {
      ...instance,
      source: {
        definitionId: plan.next.id,
        version: plan.next.version,
        revision: plan.next.revision,
        status: plan.next.status,
        contentHash: plan.next.contentHash,
        snapshot: plan.next,
      },
      resources: result.resources.length > 0 ? result.resources : instance.resources,
      baseline: await adapter.snapshot(
        result.resources.length > 0 ? result.resources : instance.resources
      ),
      updatedAt: this.now(),
    }
    await this.repository.putInstance(updated)
    return result
  }

  async detachInstance(instanceId: string): Promise<TemplateInstanceRecord> {
    const instance = await this.repository.getInstance(instanceId)
    if (!instance) throw new Error(`Template instance ${instanceId} not found`)
    const detached = { ...instance, detachedAt: instance.detachedAt ?? this.now() }
    await this.repository.putInstance(detached)
    return detached
  }

  async rebindSource(
    instanceId: string,
    definitionId: string,
    version: string
  ): Promise<TemplateInstanceRecord> {
    const instance = await this.repository.getInstance(instanceId)
    if (!instance) throw new Error(`Template instance ${instanceId} not found`)
    const source = await this.repository.getRelease(definitionId, version)
    if (!source) throw new Error(`Template release ${definitionId}@${version} not found`)
    if (source.domain !== instance.source.snapshot.domain) {
      throw new Error("Template instance cannot be rebound across domains")
    }
    const rebound: TemplateInstanceRecord = {
      ...instance,
      source: {
        definitionId: source.id,
        version: source.version,
        revision: source.revision,
        status: source.status,
        contentHash: source.contentHash,
        snapshot: source,
      },
      detachedAt: undefined,
      sourceUnavailableAt: undefined,
      updatedAt: this.now(),
    }
    await this.repository.putInstance(rebound)
    return rebound
  }

  async tombstoneCatalogSource(sourceId: string): Promise<number> {
    const sourceDefinitions = this.catalog.getSnapshot().definitions.filter((definition) => {
      if (sourceId.startsWith("plugin:")) {
        return definition.provenance.pluginId === sourceId.slice("plugin:".length)
      }
      return false
    })
    const definitionIds = new Set(sourceDefinitions.map((definition) => definition.id))
    for (const instance of await this.repository.listInstances()) {
      if (!definitionIds.has(instance.source.definitionId)) continue
      await this.repository.putInstance({
        ...instance,
        sourceUnavailableAt: instance.sourceUnavailableAt ?? this.now(),
        updatedAt: this.now(),
      })
    }
    const tombstones = await Promise.all(
      sourceDefinitions.map((definition) =>
        createTemplateDefinition({
          ...definition,
          status: "tombstone",
          payload: { sourceContentHash: definition.contentHash },
          inputs: [],
          dependencies: [],
          capabilities: [],
          baselineHash: definition.contentHash,
          contentHash: undefined,
          updatedAt: this.now(),
        })
      )
    )
    this.catalog.replaceSource(`tombstone:${sourceId}`, tombstones)
    this.catalog.removeSource(sourceId)
    return tombstones.length
  }
}
