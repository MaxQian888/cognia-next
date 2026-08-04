export const BOOT_CAPABILITIES = [
  "core-chat",
  "plugin-runtime",
  "workflow-automation",
  "integrations",
  "knowledge-agents",
  "desktop-tools",
] as const

export type BootCapability = (typeof BOOT_CAPABILITIES)[number]
export type BootProfile = "eager" | "main"

export interface BootDiagnosticsSnapshot {
  profile: BootProfile
  requested: BootCapability[]
  ready: BootCapability[]
  pending: BootCapability[]
}

interface PendingCapability {
  promise: Promise<void>
  resolveMounted: () => void
  reject: (error: Error) => void
}

const CAPABILITY_DEPENDENCIES: Partial<Record<BootCapability, readonly BootCapability[]>> = {
  "workflow-automation": ["plugin-runtime"],
  integrations: ["plugin-runtime"],
  "knowledge-agents": ["plugin-runtime"],
  "desktop-tools": ["plugin-runtime"],
}

export function resolveBootProfile(
  nodeEnv: string | undefined,
  configured: string | undefined
): BootProfile {
  return nodeEnv === "development" && configured === "main" ? "main" : "eager"
}

let bootProfile = resolveBootProfile(
  process.env.NODE_ENV,
  process.env.NEXT_PUBLIC_COGNIA_BOOT_PROFILE
)
let requested = initialRequests(bootProfile)
const ready = new Set<BootCapability>()
const pending = new Map<BootCapability, PendingCapability>()
const listeners = new Set<() => void>()
let snapshotVersion = 0

export function getBootProfile(): BootProfile {
  return bootProfile
}

export function isBootCapabilityRequested(capability: BootCapability): boolean {
  return requested.has(capability)
}

export function isBootCapabilityReady(capability: BootCapability): boolean {
  return ready.has(capability)
}

/**
 * Request a runtime capability and wait until its mounted initializer reports
 * readiness. Requests are idempotent and concurrent callers share one promise.
 */
export function ensureBootCapability(capability: BootCapability): Promise<void> {
  if (ready.has(capability)) return Promise.resolve()
  const existing = pending.get(capability)
  if (existing) return existing.promise

  let resolveMounted!: () => void
  let reject!: (error: Error) => void
  const mounted = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveMounted = resolvePromise
    reject = rejectPromise
  })
  // Install a temporary entry before recursing so dependency cycles cannot
  // create duplicate requests. The dependency map is intentionally acyclic.
  const entry: PendingCapability = { promise: mounted, resolveMounted, reject }
  pending.set(capability, entry)
  const dependencies = (CAPABILITY_DEPENDENCIES[capability] ?? []).map(ensureBootCapability)
  entry.promise = Promise.all([...dependencies, mounted]).then(() => undefined)
  void entry.promise.catch(() => {
    if (pending.get(capability) !== entry) return
    pending.delete(capability)
    requested.delete(capability)
    emitChange()
  })
  if (!requested.has(capability)) {
    requested.add(capability)
    emitChange()
  }
  return entry.promise
}

export function markBootCapabilityReady(capability: BootCapability): void {
  ready.add(capability)
  const entry = pending.get(capability)
  entry?.resolveMounted()
  if (entry) void entry.promise.finally(() => pending.delete(capability))
  emitChange()
}

export function markBootCapabilityFailed(capability: BootCapability, error: unknown): void {
  ready.delete(capability)
  requested.delete(capability)
  const normalized = error instanceof Error ? error : new Error(String(error))
  pending.get(capability)?.reject(normalized)
  pending.delete(capability)
  emitChange()
}

export function subscribeBootCapabilities(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Stable scalar snapshot for useSyncExternalStore. */
export function getBootCapabilitySnapshot(): number {
  return snapshotVersion
}

export function getBootDiagnosticsSnapshot(): BootDiagnosticsSnapshot {
  return {
    profile: bootProfile,
    requested: BOOT_CAPABILITIES.filter((capability) => requested.has(capability)),
    ready: BOOT_CAPABILITIES.filter((capability) => ready.has(capability)),
    pending: BOOT_CAPABILITIES.filter((capability) => pending.has(capability)),
  }
}

function initialRequests(profile: BootProfile): Set<BootCapability> {
  return new Set(profile === "eager" ? BOOT_CAPABILITIES : ["core-chat"])
}

function emitChange(): void {
  snapshotVersion += 1
  publishBootDiagnostics()
  for (const listener of listeners) listener()
}

function publishBootDiagnostics(): void {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return
  ;(
    globalThis as typeof globalThis & {
      __COGNIA_BOOT_DIAGNOSTICS__?: BootDiagnosticsSnapshot
    }
  ).__COGNIA_BOOT_DIAGNOSTICS__ = getBootDiagnosticsSnapshot()
}

export function __resetBootCapabilitiesForTesting(profile: BootProfile): void {
  for (const entry of pending.values()) {
    entry.reject(new Error("Boot capability state reset for testing."))
  }
  pending.clear()
  ready.clear()
  bootProfile = profile
  requested = initialRequests(profile)
  emitChange()
}

publishBootDiagnostics()
