import type { AdapterHealthState, PlatformAdapter } from "@/types/connectors"
import { appendAudit, type AuditEntryInput } from "./audit"

export type ConnectorRuntimeOwner = "adapter-instance" | "plugin"
export type ConnectorRuntimeDesiredState = "enabled" | "disabled" | "suspended"
export type ConnectorRuntimeObservedState =
  "stopped" | "building" | "starting" | "running" | "degraded" | "retry_wait" | "failed"

export interface ConnectorRuntimeSnapshot {
  id: string
  owner: ConnectorRuntimeOwner
  desiredState: ConnectorRuntimeDesiredState
  observedState: ConnectorRuntimeObservedState
  generation: number
  reasonCode: string
  changedAt: number
  nextRetryAt?: number
}

export interface ConnectorRuntimeDefinition {
  id: string
  owner: ConnectorRuntimeOwner
  desiredState(): "enabled" | "disabled"
  build(signal: AbortSignal, generation: number): Promise<PlatformAdapter>
  registerRust(adapter: PlatformAdapter, generation: number): Promise<void>
  unregisterRust(adapterId: string, generation: number): Promise<void>
  start(adapter: PlatformAdapter, signal: AbortSignal, generation: number): Promise<void>
  publish(adapter: PlatformAdapter, generation: number): void
  unpublish(adapterId: string, generation: number): void
}

export interface ActiveConnectorRuntime {
  adapter: PlatformAdapter
  abortController: AbortController
  generation: number
  definition: ConnectorRuntimeDefinition
}

class StartSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await work()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

export interface ConnectorRuntimeSupervisorOptions {
  startConcurrency?: number
  stopTimeoutMs?: number
  now?: () => number
  audit?: (entry: AuditEntryInput) => Promise<unknown>
}

export class ConnectorRuntimeSupervisor {
  private readonly definitions = new Map<string, ConnectorRuntimeDefinition>()
  private readonly active = new Map<string, ActiveConnectorRuntime>()
  private readonly snapshots = new Map<string, ConnectorRuntimeSnapshot>()
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly inProgress = new Map<string, AbortController>()
  private readonly requestedGeneration = new Map<string, number>()
  private readonly pendingRemoval = new Set<string>()
  private readonly suspendedOwners = new Set<ConnectorRuntimeOwner>()
  private readonly listeners = new Set<(snapshot: ConnectorRuntimeSnapshot) => void>()
  private readonly starts: StartSemaphore
  private readonly stopTimeoutMs: number
  private readonly now: () => number
  private readonly audit: (entry: AuditEntryInput) => Promise<unknown>

  constructor(options: ConnectorRuntimeSupervisorOptions = {}) {
    this.starts = new StartSemaphore(options.startConcurrency ?? 4)
    this.stopTimeoutMs = options.stopTimeoutMs ?? 15_000
    this.now = options.now ?? Date.now
    this.audit = options.audit ?? appendAudit
  }

  setDefinition(definition: ConnectorRuntimeDefinition): void {
    this.pendingRemoval.delete(definition.id)
    this.definitions.set(definition.id, definition)
  }

  hasDefinition(id: string): boolean {
    return this.definitions.has(id)
  }

  async removeDefinition(id: string, reason = "definition_removed"): Promise<void> {
    const definition = this.definitions.get(id)
    if (!definition) return
    const disabled = { ...definition, desiredState: () => "disabled" as const }
    this.definitions.set(id, disabled)
    this.pendingRemoval.add(id)
    await this.reconcileAdapter(id, reason)
    if (this.pendingRemoval.has(id) && !this.active.has(id)) {
      this.definitions.delete(id)
      this.pendingRemoval.delete(id)
    }
  }

  reconcileAdapter(id: string, reason: string): Promise<void> {
    return this.schedule(id, reason)
  }

  restartAdapter(id: string, reason: string): Promise<void> {
    return this.schedule(id, reason)
  }

  async suspendOwner(owner: ConnectorRuntimeOwner): Promise<void> {
    this.suspendedOwners.add(owner)
    await Promise.all(
      Array.from(this.definitions.values())
        .filter((definition) => definition.owner === owner)
        .map((definition) => this.schedule(definition.id, "owner_suspended"))
    )
  }

  async resumeOwner(owner: ConnectorRuntimeOwner): Promise<void> {
    this.suspendedOwners.delete(owner)
    await Promise.all(
      Array.from(this.definitions.values())
        .filter((definition) => definition.owner === owner)
        .map((definition) => this.schedule(definition.id, "owner_resumed"))
    )
  }

  getSnapshot(id: string): ConnectorRuntimeSnapshot | undefined {
    return this.snapshots.get(id)
  }

  subscribe(listener: (snapshot: ConnectorRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRunningAdapter(id: string): ActiveConnectorRuntime | undefined {
    return this.active.get(id)
  }

  refreshHealth(
    id: string,
    reason = "health_refresh",
    observed?: { state: AdapterHealthState; reason?: string }
  ): ConnectorRuntimeSnapshot | undefined {
    const current = this.active.get(id)
    if (!current) return this.snapshots.get(id)
    const health = observed ?? this.readHealth(current.adapter)
    this.publishSnapshot(
      current.definition,
      current.generation,
      this.observedFromHealth(health.state),
      health.reason ?? reason
    )
    return this.snapshots.get(id)
  }

  listRunningAdapters(owner?: ConnectorRuntimeOwner): ActiveConnectorRuntime[] {
    return Array.from(this.active.values()).filter(
      (runtime) => owner === undefined || runtime.definition.owner === owner
    )
  }

  adoptRunningAdapter(
    definition: ConnectorRuntimeDefinition,
    adapter: PlatformAdapter,
    abortController: AbortController,
    generation?: number
  ): void {
    this.setDefinition(definition)
    const adoptedGeneration = generation ?? (this.requestedGeneration.get(definition.id) ?? 0) + 1
    this.requestedGeneration.set(definition.id, adoptedGeneration)
    this.active.set(definition.id, {
      adapter,
      abortController,
      generation: adoptedGeneration,
      definition,
    })
    const health = this.readHealth(adapter)
    this.publishSnapshot(
      definition,
      adoptedGeneration,
      this.observedFromHealth(health.state),
      "adopted_running"
    )
  }

  resetForTesting(): void {
    for (const runtime of this.active.values()) runtime.abortController.abort()
    this.definitions.clear()
    this.active.clear()
    this.snapshots.clear()
    this.lanes.clear()
    this.inProgress.clear()
    this.requestedGeneration.clear()
    this.pendingRemoval.clear()
    this.suspendedOwners.clear()
    this.listeners.clear()
  }

  private schedule(id: string, reason: string): Promise<void> {
    const generation = (this.requestedGeneration.get(id) ?? 0) + 1
    this.requestedGeneration.set(id, generation)
    this.inProgress.get(id)?.abort()
    const previous = this.lanes.get(id) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.requestedGeneration.get(id) !== generation) return
        await this.reconcileGeneration(id, generation, reason)
      })
    this.lanes.set(id, operation)
    return operation.finally(() => {
      if (this.lanes.get(id) === operation) this.lanes.delete(id)
    })
  }

  private async reconcileGeneration(id: string, generation: number, reason: string): Promise<void> {
    const definition = this.definitions.get(id)
    if (!definition) return
    const desiredState = this.desiredState(definition)
    const current = this.active.get(id)
    if (current) {
      current.abortController.abort()
      const stopped = await this.stopWithTimeout(current.adapter)
      if (!stopped.ok) {
        current.definition.unpublish(id, current.generation)
        if (!this.isLatest(id, generation)) return
        this.publishSnapshot(definition, generation, "failed", stopped.reason)
        await this.auditError(id, stopped.reason)
        return
      }
      try {
        await current.definition.unregisterRust(id, current.generation)
      } catch (error) {
        current.definition.unpublish(id, current.generation)
        if (!this.isLatest(id, generation)) return
        this.publishSnapshot(definition, generation, "failed", "rust_unregister_failed")
        await this.auditError(id, "rust_unregister_failed", error)
        return
      }
      current.definition.unpublish(id, current.generation)
      this.active.delete(id)
    }

    if (!this.isLatest(id, generation)) return

    if (desiredState !== "enabled") {
      this.publishSnapshot(definition, generation, "stopped", reason)
      await this.safeAudit({ adapterId: id, kind: "adapter.stopped", at: this.now(), reason })
      if (this.pendingRemoval.has(id)) {
        this.definitions.delete(id)
        this.pendingRemoval.delete(id)
      }
      return
    }

    await this.starts.run(async () => {
      if (!this.isLatest(id, generation)) return
      const abortController = new AbortController()
      this.inProgress.set(id, abortController)
      let built: PlatformAdapter | undefined
      let rustRegistered = false
      let publishAttempted = false
      try {
        this.publishSnapshot(definition, generation, "building", reason)
        built = await definition.build(abortController.signal, generation)
        if (!this.isLatest(id, generation)) {
          await this.disposeStale(definition, built, abortController, generation, false)
          return
        }
        await definition.registerRust(built, generation)
        rustRegistered = true
        this.publishSnapshot(definition, generation, "starting", reason)
        await definition.start(built, abortController.signal, generation)
        if (!this.isLatest(id, generation)) {
          await this.disposeStale(definition, built, abortController, generation, rustRegistered)
          return
        }
        const health = this.readHealth(built)
        if (health.state === "down") {
          throw Object.assign(new Error(health.reason ?? "adapter health is down"), {
            reasonCode: "health_down",
          })
        }
        this.active.set(id, { adapter: built, abortController, generation, definition })
        try {
          publishAttempted = true
          definition.publish(built, generation)
        } catch (error) {
          this.active.delete(id)
          throw error
        }
        const observed = this.observedFromHealth(health.state)
        this.publishSnapshot(definition, generation, observed, reason)
        if (observed === "running") {
          await this.safeAudit({ adapterId: id, kind: "adapter.started", at: this.now() })
        }
      } catch (error) {
        abortController.abort()
        if (publishAttempted) definition.unpublish(id, generation)
        this.active.delete(id)
        if (built) await built.stop().catch(() => undefined)
        if (rustRegistered) await definition.unregisterRust(id, generation).catch(() => undefined)
        if (!this.isLatest(id, generation)) return
        const reasonCode =
          typeof error === "object" && error !== null && "reasonCode" in error
            ? String(error.reasonCode)
            : "start_failed"
        this.publishSnapshot(definition, generation, "failed", reasonCode)
        await this.auditError(id, reasonCode, error)
      } finally {
        if (this.inProgress.get(id) === abortController) this.inProgress.delete(id)
      }
    })
  }

  private desiredState(definition: ConnectorRuntimeDefinition): ConnectorRuntimeDesiredState {
    if (this.suspendedOwners.has(definition.owner)) return "suspended"
    return definition.desiredState()
  }

  private isLatest(id: string, generation: number): boolean {
    return this.requestedGeneration.get(id) === generation
  }

  private async disposeStale(
    definition: ConnectorRuntimeDefinition,
    adapter: PlatformAdapter,
    abortController: AbortController,
    generation: number,
    rustRegistered: boolean
  ): Promise<void> {
    abortController.abort()
    const stopped = await this.stopWithTimeout(adapter)
    if (!stopped.ok) {
      // A superseded build/start may already own a live transport. Retain it
      // as the cleanup target for the newest lane; otherwise that lane would
      // start a replacement after a failed stale stop and create two sockets.
      this.active.set(definition.id, { adapter, abortController, generation, definition })
      return
    }
    if (rustRegistered) {
      try {
        await definition.unregisterRust(definition.id, generation)
      } catch {
        this.active.set(definition.id, { adapter, abortController, generation, definition })
      }
    }
  }

  private readHealth(adapter: PlatformAdapter): { state: AdapterHealthState; reason?: string } {
    try {
      return adapter.health()
    } catch (error) {
      return { state: "down", reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private observedFromHealth(state: AdapterHealthState): ConnectorRuntimeObservedState {
    if (state === "running") return "running"
    if (state === "starting") return "starting"
    if (state === "degraded") return "degraded"
    return "failed"
  }

  private async stopWithTimeout(
    adapter: PlatformAdapter
  ): Promise<{ ok: true } | { ok: false; reason: "stop_timeout" | "stop_failed" }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        adapter.stop(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("stop_timeout")), this.stopTimeoutMs)
        }),
      ])
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error && error.message === "stop_timeout"
            ? "stop_timeout"
            : "stop_failed",
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private publishSnapshot(
    definition: ConnectorRuntimeDefinition,
    generation: number,
    observedState: ConnectorRuntimeObservedState,
    reasonCode: string
  ): void {
    if (!this.isLatest(definition.id, generation)) return
    const snapshot: ConnectorRuntimeSnapshot = {
      id: definition.id,
      owner: definition.owner,
      desiredState: this.desiredState(definition),
      observedState,
      generation,
      reasonCode,
      changedAt: this.now(),
    }
    this.snapshots.set(definition.id, snapshot)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers cannot break lifecycle ownership.
      }
    }
  }

  private async auditError(id: string, reason: string, error?: unknown): Promise<void> {
    await this.safeAudit({
      adapterId: id,
      kind: "adapter.error",
      at: this.now(),
      reason,
      message: error instanceof Error ? error.message : undefined,
    })
  }

  private async safeAudit(entry: AuditEntryInput): Promise<void> {
    await Promise.resolve(this.audit(entry)).catch(() => undefined)
  }
}

let singleton: ConnectorRuntimeSupervisor | null = null

export function getConnectorRuntimeSupervisor(): ConnectorRuntimeSupervisor {
  singleton ??= new ConnectorRuntimeSupervisor()
  return singleton
}

export function __resetConnectorRuntimeSupervisorForTesting(): void {
  singleton?.resetForTesting()
  singleton = null
}
