"use client"

/**
 * Live list of installed System-1 decision providers (ADR-0194): the built-in
 * remote endpoint plus whatever enabled plugins contribute. Subscribes to the
 * host registry, so a plugin enabling / disabling while the settings page is
 * open shows up without a reload.
 */

import { useMemo, useSyncExternalStore } from "react"
import { getDecisionRegistry } from "@/lib/decisions/host-registry"
import type { DecisionRegistry } from "@/lib/decisions/registry"
import type { DecisionProvider } from "@/types/decisions"

const EMPTY: readonly DecisionProvider[] = []

export function useDecisionProviders(
  registry: () => DecisionRegistry = getDecisionRegistry
): readonly DecisionProvider[] {
  const target = registry()
  return useSyncExternalStore(
    (listener) => target.subscribe(listener),
    () => target.list(),
    () => EMPTY
  )
}

/** One provider by id, or `undefined` while it is not installed. */
export function useDecisionProvider(
  id: string | undefined,
  registry: () => DecisionRegistry = getDecisionRegistry
): DecisionProvider | undefined {
  const providers = useDecisionProviders(registry)
  return useMemo(() => (id ? providers.find((p) => p.id === id) : undefined), [id, providers])
}
