/**
 * Mode router — Task 28.
 *
 * Given the resolved connector mode, a policy evaluation result, and the
 * `storeUnmatchedInDraftMode` flag, return a routing decision.
 */

import type { ConnectorMode } from "@/types/connectors/policy"
import type { PolicyEvalResult } from "./policy-eval"

export type RouteDecision = "ai-run" | "manual-store" | "draft-prepare" | "store-only" | "drop"

/**
 * Decide how to handle an inbound event after policy evaluation.
 *
 * @param mode                    - Resolved connector mode.
 * @param evalResult              - Result of `evaluatePolicy`.
 * @param storeUnmatchedInDraftMode - From the resolved trigger policy.
 * @returns                         A `RouteDecision` string.
 */
export function routeInbound(
  mode: ConnectorMode,
  evalResult: PolicyEvalResult,
  storeUnmatchedInDraftMode: boolean
): RouteDecision {
  const { matched, blocked } = evalResult

  switch (mode) {
    case "auto":
      if (matched && !blocked) return "ai-run"
      // Not matched OR blocked
      return storeUnmatchedInDraftMode ? "store-only" : "drop"

    case "manual":
      // Always store for human review regardless of policy match/block
      return "manual-store"

    case "draft":
      if (matched && !blocked) return "draft-prepare"
      // Not matched OR blocked
      return storeUnmatchedInDraftMode ? "store-only" : "drop"
  }
}
