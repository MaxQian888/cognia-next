/**
 * Decision provider registry (ADR-0194) — built-in endpoints and plugin
 * contributions (`manifest.decisionProviders[]`, `ctx.decisions.registerProvider`)
 * in one list.
 *
 * Shaped after `packages/ocr/src/registry.ts`, plus what a settings picker needs
 * that the OCR registry never had: `subscribe()` and a stable `list()` snapshot
 * (replaced only on change), so `useSyncExternalStore` sees plugin providers
 * come and go without re-rendering on every read.
 */

import type { DecisionProvider, DecisionProviderInfo } from "@/types/decisions"

export interface DecisionRegistry {
  /** Throws when the id is already taken. */
  register(provider: DecisionProvider): void
  unregister(id: string): boolean
  get(id: string): DecisionProvider | undefined
  /** Stable snapshot; a new array only after a change. */
  list(): readonly DecisionProvider[]
  subscribe(listener: () => void): () => void
  /** Drop every provider owned by the plugin (disable / uninstall). */
  clearForPlugin(pluginId: string): void
}

export function createDecisionRegistry(): DecisionRegistry {
  const providers = new Map<string, DecisionProvider>()
  const listeners = new Set<() => void>()
  let snapshot: readonly DecisionProvider[] = []

  function changed() {
    snapshot = Array.from(providers.values())
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others from seeing the change.
      }
    }
  }

  return {
    register(provider) {
      if (!provider.id) throw new Error("decision provider id must be non-empty")
      if (providers.has(provider.id)) {
        throw new Error(`decision provider "${provider.id}" is already registered`)
      }
      providers.set(provider.id, provider)
      changed()
    },
    unregister(id) {
      const removed = providers.delete(id)
      if (removed) changed()
      return removed
    },
    get: (id) => providers.get(id),
    list: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clearForPlugin(pluginId) {
      let removed = false
      for (const [id, provider] of providers) {
        if (provider.pluginId === pluginId) {
          providers.delete(id)
          removed = true
        }
      }
      if (removed) changed()
    },
  }
}

/** Plain-data view — no methods cross to plugins or the settings UI. */
export function toDecisionProviderInfo(provider: DecisionProvider): DecisionProviderInfo {
  return {
    id: provider.id,
    label: provider.label,
    ...(provider.labelKey ? { labelKey: provider.labelKey } : {}),
    ...(provider.pluginId ? { pluginId: provider.pluginId } : {}),
    locality: provider.locality,
    calibrated: provider.calibrated,
    ...(provider.limits ? { limits: provider.limits } : {}),
    ...(provider.validatedQuestionSets?.length
      ? { validatedQuestionSets: [...provider.validatedQuestionSets] }
      : {}),
  }
}
