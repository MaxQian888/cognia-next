import type { PetAssetDiagnostic, PetRenderMode } from "@/types/pet"

export type PetRenderPriority = "thumbnail" | "console" | "interactive" | "configuration"
export type PetRuntimeResource = "webglContexts" | "tickers" | "timers"

const PRIORITY: Record<PetRenderPriority, number> = {
  thumbnail: 100,
  console: 200,
  interactive: 300,
  configuration: 400,
}

export interface PetRendererDiagnostics {
  activeLiveRenderers: number
  webglContexts: number
  tickers: number
  timers: number
  objectUrls: number
  assetLoads: number
  contextLosses: number
  fallbacks: number
}

interface LeaseRecord {
  ownerId: string
  priority: PetRenderPriority
  sequence: number
  assetKey?: string
}

export interface PetRuntimeLease {
  mode(): PetRenderMode
  snapshot(): string | undefined
  release(): void
}

export interface PetSkinRuntimeDeps {
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

const EMPTY_DIAGNOSTICS: PetRendererDiagnostics = {
  activeLiveRenderers: 0,
  webglContexts: 0,
  tickers: 0,
  timers: 0,
  objectUrls: 0,
  assetLoads: 0,
  contextLosses: 0,
  fallbacks: 0,
}

/**
 * Per-WebView owner of expensive renderer resources. The module singleton is
 * naturally isolated by each WebView's JavaScript realm while remaining shared
 * by every preview inside that realm.
 */
export class PetSkinRuntime {
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly snapshots = new Map<string, string>()
  private readonly objectUrls = new Map<string, string>()
  private readonly contextLossCount = new Map<string, number>()
  private readonly degradedAssets = new Set<string>()
  private readonly failureDiagnostics = new Map<string, PetAssetDiagnostic>()
  private readonly retryGenerations = new Map<string, number>()
  private readonly loadedAssets = new Set<string>()
  private readonly assetPromises = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private readonly counters: PetRendererDiagnostics = { ...EMPTY_DIAGNOSTICS }
  private sequence = 0
  private revision = 0
  private activeOwnerId: string | null = null
  private readonly createObjectURL: (blob: Blob) => string
  private readonly revokeObjectURL: (url: string) => void

  constructor(deps: PetSkinRuntimeDeps = {}) {
    this.createObjectURL = deps.createObjectURL ?? ((blob) => URL.createObjectURL(blob))
    this.revokeObjectURL = deps.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  snapshotRevision = (): number => this.revision

  private recomputeOwner(): void {
    const previous = this.activeOwnerId
    let next: LeaseRecord | undefined
    for (const lease of this.leases.values()) {
      if (
        !next ||
        PRIORITY[lease.priority] > PRIORITY[next.priority] ||
        (PRIORITY[lease.priority] === PRIORITY[next.priority] && lease.sequence > next.sequence)
      ) {
        next = lease
      }
    }
    this.activeOwnerId = next?.ownerId ?? null
    this.counters.activeLiveRenderers = this.activeOwnerId ? 1 : 0
    if (previous !== this.activeOwnerId) this.emit()
  }

  acquireLease(ownerId: string, priority: PetRenderPriority, assetKey?: string): PetRuntimeLease {
    this.leases.set(ownerId, { ownerId, priority, assetKey, sequence: ++this.sequence })
    this.recomputeOwner()
    let released = false
    return {
      mode: () => {
        if (released) return "placeholder"
        if (this.activeOwnerId === ownerId) return "live"
        return assetKey && this.snapshots.has(assetKey) ? "snapshot" : "placeholder"
      },
      snapshot: () => (assetKey ? this.snapshots.get(assetKey) : undefined),
      release: () => {
        if (released) return
        released = true
        this.leases.delete(ownerId)
        this.recomputeOwner()
        if (
          assetKey &&
          assetKey !== "svg" &&
          ![...this.leases.values()].some((lease) => lease.assetKey === assetKey)
        ) {
          this.invalidateAsset(assetKey)
        }
      },
    }
  }

  publishSnapshot(assetKey: string, dataUrl: string): void {
    this.snapshots.set(assetKey, dataUrl)
    this.emit()
  }

  objectUrl(assetKey: string, blob: Blob): string {
    const cached = this.objectUrls.get(assetKey)
    if (cached) return cached
    const url = this.createObjectURL(blob)
    this.objectUrls.set(assetKey, url)
    this.counters.objectUrls = this.objectUrls.size
    this.markAssetLoaded(assetKey)
    return url
  }

  markAssetLoaded(assetKey: string): void {
    if (this.loadedAssets.has(assetKey)) return
    this.loadedAssets.add(assetKey)
    this.counters.assetLoads += 1
  }

  loadAsset<T>(assetKey: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.assetPromises.get(assetKey) as Promise<T> | undefined
    if (cached) return cached
    this.markAssetLoaded(assetKey)
    const pending = loader().catch((error) => {
      this.assetPromises.delete(assetKey)
      this.loadedAssets.delete(assetKey)
      throw error
    })
    this.assetPromises.set(assetKey, pending)
    return pending
  }

  invalidateAsset(assetKey: string): void {
    const url = this.objectUrls.get(assetKey)
    if (url) this.revokeObjectURL(url)
    this.objectUrls.delete(assetKey)
    this.snapshots.delete(assetKey)
    this.loadedAssets.delete(assetKey)
    this.assetPromises.delete(assetKey)
    this.contextLossCount.delete(assetKey)
    this.degradedAssets.delete(assetKey)
    this.failureDiagnostics.delete(assetKey)
    this.retryGenerations.delete(assetKey)
    this.counters.objectUrls = this.objectUrls.size
    this.emit()
  }

  track(resource: PetRuntimeResource): () => void {
    this.counters[resource] += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.counters[resource] = Math.max(0, this.counters[resource] - 1)
    }
  }

  recordContextLoss(
    assetKey: string
  ): { action: "retry"; delayMs: number } | { action: "degraded" } {
    const count = (this.contextLossCount.get(assetKey) ?? 0) + 1
    this.contextLossCount.set(assetKey, count)
    this.counters.contextLosses += 1
    if (count === 1) return { action: "retry", delayMs: 250 }
    this.degradedAssets.add(assetKey)
    this.counters.fallbacks += 1
    this.emit()
    return { action: "degraded" }
  }

  retryAsset(assetKey: string): void {
    this.contextLossCount.delete(assetKey)
    this.degradedAssets.delete(assetKey)
    this.failureDiagnostics.delete(assetKey)
    this.retryGenerations.set(assetKey, (this.retryGenerations.get(assetKey) ?? 0) + 1)
    this.emit()
  }

  assetDiagnostic(assetKey: string): PetAssetDiagnostic | undefined {
    const failure = this.failureDiagnostics.get(assetKey)
    if (failure) return failure
    if (!this.degradedAssets.has(assetKey)) return undefined
    return { code: "contextLost", severity: "error", recoverable: true }
  }

  retryGeneration(assetKey: string): number {
    return this.retryGenerations.get(assetKey) ?? 0
  }

  recordAssetFailure(assetKey: string, sourceCode: string): void {
    const code: PetAssetDiagnostic["code"] =
      sourceCode === "modelMissing"
        ? "assetMissing"
        : sourceCode === "coreMissing" || sourceCode === "engineFailed"
          ? "runtimeUnavailable"
          : "renderFailed"
    this.failureDiagnostics.set(assetKey, {
      code,
      severity: "error",
      detail: sourceCode,
      recoverable: true,
    })
    this.counters.fallbacks += 1
    this.emit()
  }

  diagnostics(): Readonly<PetRendererDiagnostics> {
    return { ...this.counters }
  }

  destroy(): void {
    for (const key of [...this.objectUrls.keys()]) this.invalidateAsset(key)
    this.leases.clear()
    this.snapshots.clear()
    this.contextLossCount.clear()
    this.degradedAssets.clear()
    this.failureDiagnostics.clear()
    this.retryGenerations.clear()
    this.loadedAssets.clear()
    this.assetPromises.clear()
    this.activeOwnerId = null
    Object.assign(this.counters, EMPTY_DIAGNOSTICS)
    this.listeners.clear()
  }
}

const RUNTIME_KEY = Symbol.for("cognia.pet.skin-runtime")
const RUNTIME_TEARDOWN_KEY = Symbol.for("cognia.pet.skin-runtime-teardown")

/** Get the one skin runtime in the current WebView realm. */
export function getPetSkinRuntime(): PetSkinRuntime {
  const root = globalThis as typeof globalThis & {
    [RUNTIME_KEY]?: PetSkinRuntime
    [RUNTIME_TEARDOWN_KEY]?: boolean
  }
  root[RUNTIME_KEY] ??= new PetSkinRuntime()
  if (typeof window !== "undefined" && !root[RUNTIME_TEARDOWN_KEY]) {
    root[RUNTIME_TEARDOWN_KEY] = true
    window.addEventListener("pagehide", () => {
      root[RUNTIME_KEY]?.destroy()
      delete root[RUNTIME_KEY]
    })
  }
  return root[RUNTIME_KEY]
}

export function resetPetSkinRuntimeForTests(): void {
  const root = globalThis as typeof globalThis & { [RUNTIME_KEY]?: PetSkinRuntime }
  root[RUNTIME_KEY]?.destroy()
  delete root[RUNTIME_KEY]
}
