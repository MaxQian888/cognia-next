/**
 * Provider Operation Adapter Registry (ADR-0163): the dynamic overlay for
 * plugin-contributed operation handlers.
 *
 * Plugins shipping the `provider-operation-adapter` capability call
 * `registerProviderOperationAdapter` on enable through the
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in `lib/plugin/core/manager.ts`.
 * On disable the manager calls `unregisterProviderOperationAdaptersByPlugin`.
 *
 * Registering here does two things at once: the overlay keeps the definition
 * (so the capability matrix can project it as a `plugin` cell), and the
 * operation handler registry receives a handler with `support: "plugin"` and
 * `via: "<pluginId>:<adapterId>"` (so the executor can dispatch to it). Both
 * are dropped together, so a disabled plugin can never keep serving.
 */

import { providerOperationHandlerRegistry } from "@/lib/ai/operations/registry"
import type { PluginProviderOperationAdapterDef } from "@/types/plugin/plugin-provider-operation-adapter"

import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginProviderOperationAdapterDef>({
  name: "provider-operation-adapter",
  // An operation adapter executes with the provider's credential. A later
  // plugin must not be able to take over another plugin's adapter id.
  conflictPolicy: "first-wins-cross-plugin",
})

/** Handler disposers keyed by registry id. */
const bound = new Map<string, () => void>()

function unbind(id: string): void {
  bound.get(id)?.()
  bound.delete(id)
}

/** `<pluginId>:<adapterId>`, the `via` the matrix and the executor report. */
export function providerOperationAdapterVia(id: string, pluginId?: string): string {
  if (!pluginId || id.startsWith(`${pluginId}:`)) return id
  return `${pluginId}:${id}`
}

/**
 * Register a plugin-contributed operation adapter. Returns the incumbent when
 * another plugin already owns `id` (the overlay refuses the overwrite), in
 * which case no handler is bound.
 */
export function registerProviderOperationAdapter(
  id: string,
  def: PluginProviderOperationAdapterDef,
  opts?: { pluginId?: string }
): ReturnType<typeof registry.register> {
  const previous = registry.register(id, def, opts)
  const accepted = registry.get(id) === def
  if (!accepted) return previous
  unbind(id)
  bound.set(
    id,
    providerOperationHandlerRegistry.register({
      operationId: def.operationId,
      providerMatch: def.providerMatch,
      support: "plugin",
      via: providerOperationAdapterVia(id, opts?.pluginId),
      handler: def.handler,
    })
  )
  return previous
}

/** Drop a single dynamically-registered adapter by id, handler included. */
export function unregisterProviderOperationAdapterById(id: string): boolean {
  unbind(id)
  return registry.unregisterById(id)
}

/** Drop every adapter contributed by `pluginId`. Returns the number removed. */
export function unregisterProviderOperationAdaptersByPlugin(pluginId: string): number {
  for (const { id, pluginId: owner } of registry.entries()) {
    if (owner === pluginId) unbind(id)
  }
  return registry.unregisterByPlugin(pluginId)
}

/** Get an adapter by id. Returns undefined when not registered. */
export const getProviderOperationAdapter = registry.get
/** Get the full registry entry (adapter + pluginId tag) for an id. */
export const getProviderOperationAdapterEntry = registry.getEntry
/** List every registered adapter id in registration order. */
export const listProviderOperationAdapterIds = registry.list
/** List every registered entry (id + adapter + pluginId) in registration order. */
export const listProviderOperationAdapterEntries = registry.entries

/** Test-only: clear every dynamically registered adapter and its handler. */
export function __resetProviderOperationAdaptersForTesting(): void {
  for (const id of [...bound.keys()]) unbind(id)
  registry.__resetForTesting()
}
