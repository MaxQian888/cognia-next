import type { PluginActualState, PluginDirtyDiagnostic, PluginIntent } from "./lifecycle-state"

export interface PluginActivationLease {
  managerId: string
  pluginId: string
  generation: number
}

export interface PluginLifecycleEffectSnapshot {
  active: number
  pending: number
  failed: number
  labels: string[]
}

export interface PluginLifecycleCoordinatorSnapshot {
  managerId: string
  pluginId: string
  generation: number
  intent: PluginIntent
  actual: PluginActualState
  stateSince: number
  requiredServices: string[]
  providedServices: string[]
  currentProviders: string[]
  effects: PluginLifecycleEffectSnapshot
  dirty?: PluginDirtyDiagnostic
  pendingTransition?: string
  lastError?: string
  packageRevision?: string
  source?: string
  configRevision?: number
}

type SnapshotListener = (snapshot: readonly PluginLifecycleCoordinatorSnapshot[]) => void

export interface PluginGraphReservation {
  managerId: string
  pluginId: string
  token: number
}

export class PluginActivationConflictError extends Error {
  constructor(
    readonly pluginId: string,
    readonly ownerManagerId: string
  ) {
    super(`Plugin ${pluginId} is already active in manager ${ownerManagerId}`)
    this.name = "PluginActivationConflictError"
  }
}

export class PluginProviderDrainingError extends Error {
  constructor(readonly pluginId: string) {
    super(`Plugin dependency ${pluginId} is draining`)
    this.name = "PluginProviderDrainingError"
  }
}

export class PluginLifecycleCoordinator {
  private readonly leases = new Map<string, PluginActivationLease>()
  private readonly generations = new Map<string, number>()
  private readonly drainingProviders = new Map<string, PluginGraphReservation>()
  private readonly reservationDepth = new Map<string, number>()
  private readonly diagnosticSnapshots = new Map<string, PluginLifecycleCoordinatorSnapshot>()
  private readonly snapshotListeners = new Set<SnapshotListener>()
  private reservationSequence = 0

  acquire(managerId: string, pluginId: string): PluginActivationLease {
    const current = this.leases.get(pluginId)
    if (current) {
      throw new PluginActivationConflictError(pluginId, current.managerId)
    }
    const generation = (this.generations.get(pluginId) ?? 0) + 1
    this.generations.set(pluginId, generation)
    const lease = { managerId, pluginId, generation }
    this.leases.set(pluginId, lease)
    return lease
  }

  isCurrent(lease: PluginActivationLease): boolean {
    const current = this.leases.get(lease.pluginId)
    return Boolean(
      current && current.managerId === lease.managerId && current.generation === lease.generation
    )
  }

  release(lease: PluginActivationLease): boolean {
    if (!this.isCurrent(lease)) return false
    this.leases.delete(lease.pluginId)
    return true
  }

  get(pluginId: string): PluginActivationLease | undefined {
    return this.leases.get(pluginId)
  }

  reserveProviderDrain(managerId: string, pluginId: string): PluginGraphReservation {
    const current = this.drainingProviders.get(pluginId)
    if (current) {
      if (current.managerId !== managerId) throw new PluginProviderDrainingError(pluginId)
      this.reservationDepth.set(pluginId, (this.reservationDepth.get(pluginId) ?? 1) + 1)
      return current
    }
    this.reservationSequence += 1
    const reservation = { managerId, pluginId, token: this.reservationSequence }
    this.drainingProviders.set(pluginId, reservation)
    this.reservationDepth.set(pluginId, 1)
    return reservation
  }

  releaseProviderDrain(reservation: PluginGraphReservation): boolean {
    const current = this.drainingProviders.get(reservation.pluginId)
    if (
      !current ||
      current.managerId !== reservation.managerId ||
      current.token !== reservation.token
    ) {
      return false
    }
    const depth = this.reservationDepth.get(reservation.pluginId) ?? 1
    if (depth > 1) {
      this.reservationDepth.set(reservation.pluginId, depth - 1)
      return true
    }
    this.reservationDepth.delete(reservation.pluginId)
    this.drainingProviders.delete(reservation.pluginId)
    return true
  }

  isProviderDraining(pluginId: string): boolean {
    return this.drainingProviders.has(pluginId)
  }

  assertProvidersAccepting(pluginIds: Iterable<string>): void {
    for (const pluginId of pluginIds) {
      if (this.isProviderDraining(pluginId)) throw new PluginProviderDrainingError(pluginId)
    }
  }

  updateSnapshot(snapshot: PluginLifecycleCoordinatorSnapshot): boolean {
    const lease = this.leases.get(snapshot.pluginId)
    if (
      lease &&
      (lease.managerId !== snapshot.managerId || lease.generation !== snapshot.generation)
    ) {
      return false
    }
    const existing = this.diagnosticSnapshots.get(snapshot.pluginId)
    if (!lease && existing && existing.generation > snapshot.generation) return false
    this.diagnosticSnapshots.set(snapshot.pluginId, this.sanitizeSnapshot(snapshot))
    this.emitSnapshots()
    return true
  }

  getSnapshot(pluginId: string): PluginLifecycleCoordinatorSnapshot | undefined {
    const snapshot = this.diagnosticSnapshots.get(pluginId)
    return snapshot ? structuredClone(snapshot) : undefined
  }

  snapshot(): PluginLifecycleCoordinatorSnapshot[] {
    return Array.from(this.diagnosticSnapshots.values(), (snapshot) =>
      structuredClone(snapshot)
    ).sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  private sanitizeSnapshot(
    snapshot: PluginLifecycleCoordinatorSnapshot
  ): PluginLifecycleCoordinatorSnapshot {
    const bounded = (values: readonly string[], limit = 50): string[] =>
      values.slice(0, limit).map((value) => value.slice(0, 128))
    return {
      ...snapshot,
      requiredServices: bounded(snapshot.requiredServices),
      providedServices: bounded(snapshot.providedServices),
      currentProviders: bounded(snapshot.currentProviders),
      effects: {
        active: Math.max(0, snapshot.effects.active),
        pending: Math.max(0, snapshot.effects.pending),
        failed: Math.max(0, snapshot.effects.failed),
        labels: bounded(snapshot.effects.labels, 20),
      },
      ...(snapshot.dirty
        ? {
            dirty: {
              ...snapshot.dirty,
              message: snapshot.dirty.message.slice(0, 512),
              ...(snapshot.dirty.runtimeGeneration
                ? { runtimeGeneration: snapshot.dirty.runtimeGeneration.slice(0, 128) }
                : {}),
              ...(snapshot.dirty.labels ? { labels: bounded(snapshot.dirty.labels, 20) } : {}),
            },
          }
        : {}),
      ...(snapshot.lastError ? { lastError: snapshot.lastError.slice(0, 512) } : {}),
      ...(snapshot.pendingTransition
        ? { pendingTransition: snapshot.pendingTransition.slice(0, 128) }
        : {}),
    }
  }

  private emitSnapshots(): void {
    const snapshot = this.snapshot()
    for (const listener of this.snapshotListeners) listener(snapshot)
  }
}

export const pluginLifecycleCoordinator = new PluginLifecycleCoordinator()
