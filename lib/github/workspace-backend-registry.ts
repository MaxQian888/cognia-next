/**
 * Workspace backend registry — a Map of plugin-contributed workspace
 * backends keyed by backend id.
 *
 * Two backends in production today:
 *   - `"cognia-e2b-sandbox:e2b"` — registered by `plugins/e2b-sandbox`
 *     through `ctx.workspace.registerBackend({ id: "e2b" })` (Firecracker
 *     microVM). The plugin API prefixes the id with the plugin id.
 *   - implicit `"local"` — handled by Tauri Rust commands directly in
 *     `workspace.ts:cloneToWorkspace`; not registered here because it has
 *     no JS-side implementation to inject.
 *
 * `ctx.workspace.registerBackend(...)` (`lib/plugin/api/workspace-api.ts`) is
 * the only production writer. The host dispatches by *kind* (the unprefixed
 * id, e.g. `"e2b"`) via `resolveWorkspaceBackendByKind`, so whichever plugin
 * contributed a backend of that kind is reachable without the host knowing
 * the plugin id.
 *
 * ADR-0026 §2 §D.
 */

import type { E2BBackend } from "./workspace"

export interface WorkspaceBackendRegistration {
  /** Already-prefixed backend id (`<pluginId>:<id>`; unprefixed only in tests/host code). */
  backendId: string
  /** Owning plugin id; "host" for host-owned registrations. */
  pluginId: string
  /** Human label shown in the picker UI. */
  label: string
  /** Optional description rendered alongside the label. */
  description?: string
  /** The actual backend instance. */
  backend: E2BBackend
}

const registry = new Map<string, WorkspaceBackendRegistration>()
const listeners = new Set<(event: WorkspaceBackendRegistryEvent) => void>()

export type WorkspaceBackendRegistryEvent =
  | { type: "register"; backendId: string; pluginId: string }
  | { type: "unregister"; backendId: string; pluginId: string }

function emit(event: WorkspaceBackendRegistryEvent): void {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch (err) {
      // Listeners must not throw across the registry boundary.

      console.warn("WorkspaceBackendRegistry listener threw:", err)
    }
  }
}

/**
 * Register a backend. Throws if `backendId` is already taken — caller
 * should unregister the prior entry first if hot-reloading.
 */
export function registerWorkspaceBackend(reg: WorkspaceBackendRegistration): void {
  if (registry.has(reg.backendId)) {
    throw new Error(
      `WorkspaceBackendRegistry: duplicate backendId "${reg.backendId}" (owner ${
        registry.get(reg.backendId)!.pluginId
      })`
    )
  }
  registry.set(reg.backendId, reg)
  emit({ type: "register", backendId: reg.backendId, pluginId: reg.pluginId })
}

/**
 * Unregister a backend. Idempotent — no-op if the id isn't registered.
 */
export function unregisterWorkspaceBackend(backendId: string): boolean {
  const entry = registry.get(backendId)
  if (!entry) return false
  registry.delete(backendId)
  emit({ type: "unregister", backendId, pluginId: entry.pluginId })
  return true
}

export function getWorkspaceBackend(backendId: string): E2BBackend | undefined {
  return registry.get(backendId)?.backend
}

export function hasWorkspaceBackend(backendId: string): boolean {
  return registry.has(backendId)
}

/**
 * Resolve a backend by its unprefixed *kind* (e.g. `"e2b"`), which is what
 * the host's `WorkspaceBackend` string union selects on.
 *
 * Plugin registrations are namespaced as `<pluginId>:<id>` by
 * `lib/plugin/api/workspace-api.ts`, so a host lookup for the bare kind
 * used to miss every plugin-contributed backend (the historic bug: the
 * plugin registered `cognia-e2b-sandbox:e2b` while `cloneToWorkspace`
 * looked up `"e2b"`). Precedence: an exact (unprefixed) match wins, then
 * the first registration whose id ends in `:<kind>` in registration order.
 * Returns `undefined` when nothing matches.
 */
export function resolveWorkspaceBackendByKind(kind: string): E2BBackend | undefined {
  const exact = registry.get(kind)
  if (exact) return exact.backend
  const suffix = `:${kind}`
  for (const [id, reg] of registry) {
    if (id.endsWith(suffix)) return reg.backend
  }
  return undefined
}

export function listWorkspaceBackends(): WorkspaceBackendRegistration[] {
  return Array.from(registry.values())
}

/** Drop every registration owned by `pluginId`. Used on plugin disable. */
export function clearWorkspaceBackendsForPlugin(pluginId: string): void {
  const toDrop: string[] = []
  for (const [id, reg] of registry) {
    if (reg.pluginId === pluginId) toDrop.push(id)
  }
  for (const id of toDrop) unregisterWorkspaceBackend(id)
}

export function subscribeWorkspaceBackendRegistry(
  listener: (event: WorkspaceBackendRegistryEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: clear all entries. */
export function __resetWorkspaceBackendRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
}
