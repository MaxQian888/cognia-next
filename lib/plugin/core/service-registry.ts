import { satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"
import { REALM_OVERRIDABLE_PLUGIN_SERVICES } from "./service-catalog"
import {
  realmLookupOrder,
  validatePluginRealmId,
  type PluginRealmContext,
  type PluginRealmId,
} from "./realm"

export type PluginServiceStatus = "starting" | "available" | "draining"

export interface PluginServiceRecord {
  serviceId: string
  version: string
  providerPluginId: string
  generation: number
  status: PluginServiceStatus
  realmId: string
}

export interface PluginServiceRequirementIssue {
  serviceId: string
  constraint: string
  kind: "missing" | "version-mismatch"
  foundVersion?: string
}

export interface PluginServiceEvaluation {
  required: PluginServiceRequirementIssue[]
  optional: PluginServiceRequirementIssue[]
}

export interface PluginServiceManifest {
  id: string
  providesServices?: Record<string, string>
  requiresServices?: Record<string, string>
  optionalServices?: Record<string, string>
}

export class PluginServiceDuplicateProviderError extends Error {
  constructor(
    readonly serviceId: string,
    readonly providerPluginId: string,
    readonly existingProviderPluginId: string
  ) {
    super(
      `Service ${serviceId} is already provided by ${existingProviderPluginId}; ${providerPluginId} cannot publish it`
    )
    this.name = "PluginServiceDuplicateProviderError"
  }
}

export class PluginServiceRealmOverrideError extends Error {
  constructor(
    readonly serviceId: string,
    readonly realmId: string
  ) {
    super(`Service ${serviceId} is not realm-overridable and cannot be published in ${realmId}`)
    this.name = "PluginServiceRealmOverrideError"
  }
}

export interface PluginServiceRegistryOptions {
  realmOverridableServices?: Iterable<string>
}

type RealmLookup = PluginRealmId | PluginRealmContext

type Listener = (snapshot: readonly PluginServiceRecord[]) => void

/** Host-local metadata graph. It never exposes a generic service invocation channel. */
export class PluginServiceRegistry {
  private readonly records = new Map<string, PluginServiceRecord>()
  private readonly listeners = new Set<Listener>()
  private readonly realmOverridableServices: ReadonlySet<string>

  constructor(options: PluginServiceRegistryOptions = {}) {
    this.realmOverridableServices = new Set(
      options.realmOverridableServices ?? REALM_OVERRIDABLE_PLUGIN_SERVICES
    )
  }

  beginProvider(
    providerPluginId: string,
    generation: number,
    services: Record<string, string> = {},
    realmId: PluginRealmId = "global"
  ): void {
    validatePluginRealmId(realmId)
    for (const [serviceId, version] of Object.entries(services)) {
      if (realmId !== "global" && !this.realmOverridableServices.has(serviceId)) {
        throw new PluginServiceRealmOverrideError(serviceId, realmId)
      }
      const key = this.key(realmId, serviceId)
      const existing = this.records.get(key)
      if (
        existing &&
        (existing.providerPluginId !== providerPluginId || existing.generation !== generation)
      ) {
        throw new PluginServiceDuplicateProviderError(
          serviceId,
          providerPluginId,
          existing.providerPluginId
        )
      }
      this.records.set(key, {
        serviceId,
        version,
        providerPluginId,
        generation,
        status: "starting",
        realmId,
      })
    }
    this.emit()
  }

  publishProvider(providerPluginId: string, generation: number): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (record.providerPluginId === providerPluginId && record.generation === generation) {
        this.records.set(key, { ...record, status: "available" })
        changed = true
      }
    }
    if (changed) this.emit()
  }

  markProviderDraining(providerPluginId: string, generation?: number): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (
        record.providerPluginId === providerPluginId &&
        (generation === undefined || record.generation === generation)
      ) {
        this.records.set(key, { ...record, status: "draining" })
        changed = true
      }
    }
    if (changed) this.emit()
  }

  removeProvider(providerPluginId: string, generation?: number): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (
        record.providerPluginId === providerPluginId &&
        (generation === undefined || record.generation === generation)
      ) {
        this.records.delete(key)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  getProvider(serviceId: string, realm: RealmLookup = "global"): PluginServiceRecord | undefined {
    const context: PluginRealmContext =
      typeof realm === "string" ? { realmId: validatePluginRealmId(realm) } : realm
    const lookup =
      context.realmId === "global" || this.realmOverridableServices.has(serviceId)
        ? realmLookupOrder(context)
        : (["global"] as PluginRealmId[])
    for (const realmId of lookup) {
      const record = this.records.get(this.key(realmId, serviceId))
      if (record?.status === "available") return { ...record }
    }
    return undefined
  }

  isAvailable(serviceId: string, realm: RealmLookup = "global"): boolean {
    return Boolean(this.getProvider(serviceId, realm))
  }

  evaluate(
    required: Record<string, string> = {},
    optional: Record<string, string> = {},
    realm: RealmLookup = "global"
  ): PluginServiceEvaluation {
    return {
      required: this.evaluateSet(required, realm),
      optional: this.evaluateSet(optional, realm),
    }
  }

  consumersOf(
    providerPluginId: string,
    manifests: Iterable<{
      id: string
      requiresServices?: Record<string, string>
    }>
  ): string[] {
    const services = new Set(
      this.snapshot()
        .filter((record) => record.providerPluginId === providerPluginId)
        .map((record) => record.serviceId)
    )
    return Array.from(manifests)
      .filter((manifest) =>
        Object.keys(manifest.requiresServices ?? {}).some((serviceId) => services.has(serviceId))
      )
      .map((manifest) => manifest.id)
      .sort()
  }

  optionalConsumersOf(
    providerPluginId: string,
    manifests: Iterable<PluginServiceManifest>
  ): string[] {
    const services = new Set(
      this.snapshot()
        .filter((record) => record.providerPluginId === providerPluginId)
        .map((record) => record.serviceId)
    )
    return Array.from(manifests)
      .filter((manifest) =>
        Object.keys(manifest.optionalServices ?? {}).some((serviceId) => services.has(serviceId))
      )
      .map((manifest) => manifest.id)
      .sort()
  }

  findRequiredCycles(manifests: Iterable<PluginServiceManifest>): string[][] {
    const entries = Array.from(manifests)
    const providers = new Map<string, string[]>()
    for (const manifest of entries) {
      for (const serviceId of Object.keys(manifest.providesServices ?? {})) {
        const ids = providers.get(serviceId) ?? []
        ids.push(manifest.id)
        providers.set(serviceId, ids)
      }
    }
    const edges = new Map<string, Set<string>>()
    for (const manifest of entries) {
      const targets = new Set<string>()
      for (const serviceId of Object.keys(manifest.requiresServices ?? {})) {
        const candidates = providers.get(serviceId) ?? []
        if (candidates.length === 1) targets.add(candidates[0])
      }
      edges.set(manifest.id, targets)
    }

    const cycles = new Map<string, string[]>()
    const visit = (start: string, node: string, path: string[], seen: Set<string>): void => {
      if (seen.has(node)) return
      seen.add(node)
      for (const next of edges.get(node) ?? []) {
        if (next === start) {
          const cycle = [...path, node].sort()
          cycles.set(cycle.join("\u0000"), cycle)
        } else {
          visit(start, next, [...path, node], new Set(seen))
        }
      }
    }
    for (const id of edges.keys()) visit(id, id, [], new Set())
    return Array.from(cycles.values()).sort((a, b) => a.join(":").localeCompare(b.join(":")))
  }

  snapshot(): PluginServiceRecord[] {
    return Array.from(this.records.values(), (record) => ({ ...record })).sort((a, b) =>
      `${a.realmId}:${a.serviceId}`.localeCompare(`${b.realmId}:${b.serviceId}`)
    )
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private evaluateSet(
    requirements: Record<string, string>,
    realm: RealmLookup
  ): PluginServiceRequirementIssue[] {
    const issues: PluginServiceRequirementIssue[] = []
    for (const [serviceId, constraint] of Object.entries(requirements)) {
      const provider = this.getProvider(serviceId, realm)
      if (!provider) {
        issues.push({ serviceId, constraint, kind: "missing" })
      } else if (!satisfiesConstraint(provider.version, constraint)) {
        issues.push({
          serviceId,
          constraint,
          kind: "version-mismatch",
          foundVersion: provider.version,
        })
      }
    }
    return issues
  }

  private key(realmId: string, serviceId: string): string {
    return `${realmId}\u0000${serviceId}`
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const pluginServiceRegistry = new PluginServiceRegistry()
