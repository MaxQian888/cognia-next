/**
 * Routing-strategy registry: static built-ins ⊕ a dynamic overlay for
 * plugin/host-registered custom selectors (LiteLLM CustomRoutingStrategy
 * analog). Built-ins are consulted FIRST and can never be shadowed — a
 * plugin overriding "cost" would silently change every user's routing.
 *
 * Same `static ⊕ overlay` composition the external-agent preset registry
 * uses (`createOverlayRegistry` docs, design rule #1).
 */

import { createOverlayRegistry } from "./overlay-registry"
import type { RoutingStrategySelector } from "@cognia/provider-types/routing-strategy"
import { BUILT_IN_ROUTING_SELECTORS } from "./strategies/built-in"

const builtIns = new Map<string, RoutingStrategySelector>(
  BUILT_IN_ROUTING_SELECTORS.map((selector) => [selector.id, selector])
)

const overlay = createOverlayRegistry<RoutingStrategySelector>({
  name: "routing-strategies",
  conflictPolicy: "first-wins-cross-plugin",
})

/** Resolve a selector by id — built-ins first, then the dynamic overlay. */
export function getRoutingStrategy(id: string): RoutingStrategySelector | undefined {
  return builtIns.get(id) ?? overlay.get(id)
}

/**
 * Register a custom selector. Built-in ids are rejected (returns false) so
 * the historical strategies stay authoritative.
 */
export function registerRoutingStrategy(
  selector: RoutingStrategySelector,
  opts?: { pluginId?: string }
): boolean {
  if (builtIns.has(selector.id)) {
    return false
  }
  overlay.register(selector.id, selector, opts)
  return true
}

export function unregisterRoutingStrategy(id: string): boolean {
  return overlay.unregisterById(id)
}

export function unregisterRoutingStrategiesByPlugin(pluginId: string): number {
  return overlay.unregisterByPlugin(pluginId)
}

/** Every known strategy id (built-ins first, then customs) for pickers. */
export function listRoutingStrategies(): Array<{
  id: string
  label: string
  builtIn: boolean
  pluginId?: string
}> {
  const customs = overlay.entries().map(({ id, entry, pluginId }) => ({
    id,
    label: entry.label ?? id,
    builtIn: false,
    pluginId,
  }))
  const statics = BUILT_IN_ROUTING_SELECTORS.map((selector) => ({
    id: selector.id as string,
    label: selector.label ?? (selector.id as string),
    builtIn: true,
  }))
  return [...statics, ...customs]
}

/** Test-only: drop every custom selector. */
export function __resetRoutingStrategiesForTesting(): void {
  overlay.__resetForTesting()
}
