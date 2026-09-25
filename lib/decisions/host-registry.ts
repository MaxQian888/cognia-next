/**
 * The host's decision provider registry: the built-in remote endpoint plus
 * whatever plugins contribute (ADR-0194). Created on first use so importing
 * the decisions modules never registers anything as a side effect.
 */

import { createDecisionRegistry, type DecisionRegistry } from "@/lib/decisions/registry"
import { createDecisionsHttpProvider } from "@/lib/decisions/providers/decisions-http"

let shared: DecisionRegistry | null = null

export function getDecisionRegistry(): DecisionRegistry {
  if (!shared) {
    shared = createDecisionRegistry()
    shared.register(createDecisionsHttpProvider())
  }
  return shared
}

/** Test-only. */
export function __resetDecisionRegistryForTesting(): void {
  shared = null
}
