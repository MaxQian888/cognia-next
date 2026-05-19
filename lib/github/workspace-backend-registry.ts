/**
 * Workspace backend registry — generalizes the legacy `_e2bBackend`
 * singleton in `workspace.ts` into a Map keyed by backend id.
 *
 * Two backends in production today:
 *   - `"e2b"`   — registered by `plugins/e2b-sandbox` (Firecracker microVM).
 *   - implicit `"local"` — handled by Tauri Rust commands directly in
 *     `workspace.ts:cloneToWorkspace`; not registered here because it has
 *     no JS-side implementation to inject.
 *
 * The registry is the destination both the legacy `setE2BBackend()` shim
 * and the new `ctx.workspace.registerBackend(...)` API funnel through.
 *
 * ADR-0026 §2 §D.
 */

import type { E2BBackend } from "./workspace"

export interface WorkspaceBackendRegistration {
  /** Already-prefixed backend id (`<pluginId>:<id>` or unprefixed for legacy). */
  backendId: string
  /** Owning plugin id; "host" for the legacy `setE2BBackend` shim. */
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
