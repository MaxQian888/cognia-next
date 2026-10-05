/**
 * Typed vendor extensions (ADR-0217).
 *
 * Some runtimes expose controls no other runtime has (Codex's account, rate
 * limits, MCP and skill status). The UI and CLI reach them through an
 * extension the integration package defines, never through the host manager
 * importing a vendor class: the manager only asks "does this adapter answer
 * extension X?", and the package decides what that means.
 *
 * Deliberately not a stringly `invoke(method, args)` escape hatch: an
 * extension is a typed value, so callers keep full type checking.
 */

import type { ExternalAgentAdapterCore } from "./adapter"

export interface AdapterExtension<T> {
  /** Stable id, namespaced by integration (`codex.app-server`). */
  readonly id: string
  /** The extension surface of `adapter`, or `undefined` when it has none. */
  resolve(adapter: ExternalAgentAdapterCore): T | undefined
}

export function defineAdapterExtension<T>(
  id: string,
  resolve: (adapter: ExternalAgentAdapterCore) => T | undefined
): AdapterExtension<T> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id)) {
    throw new Error(`Adapter extension id must be namespaced ("vendor.surface"): ${id}`)
  }
  return Object.freeze({ id, resolve })
}
