/**
 * Thread B — delegation router.
 *
 * Wraps the {@link ExternalAgentManager}'s layered, priority-sorted,
 * first-match rule matcher (`checkDelegation`, which also enforces target
 * connection state) and adds the cross-boundary concerns the raw matcher lacks:
 *
 *  - an `inputFilter` (the PII gate) that produces the `filteredPrompt` actually
 *    sent to the external CLI, retaining the `redactionMap` for UI hydration;
 *  - a normalized {@link RoutingDecision} shape (rule id + name + filtered text)
 *    the chat send seam can render a "delegated to X" badge from.
 *
 * Kept pure and synchronous by injecting both the matcher and the redactor —
 * the chat hook supplies `manager.checkDelegation` (after syncing store rules
 * into the manager) and `redactText`. This makes the routing decision fully
 * unit-testable without the manager singleton or the PII engine.
 */

import type {
  ExternalAgentBranchReasonCode,
  ExternalAgentDelegationResult,
} from "@/types/agent/external-agent"
import type { RedactionRecord } from "@/lib/twin/ingest/redact"

export interface RouteDelegationInput {
  /** The user prompt for this turn. */
  prompt: string
  /** Optional opaque context forwarded to the matcher. */
  context?: Record<string, unknown>
}

export interface RouteDelegationDeps {
  /**
   * The manager's rule matcher. Already priority-sorted + connection-gated.
   * Injected so the router stays pure/testable.
   */
  checkDelegation: (
    task: string,
    context?: Record<string, unknown>
  ) => ExternalAgentDelegationResult
  /**
   * PII redactor (the inputFilter). When provided, the prompt is redacted
   * before it is handed to the external CLI. Omit to send the raw prompt
   * (e.g. when per-rule redaction is disabled).
   */
  redact?: (text: string) => { redacted: string; map: Record<string, RedactionRecord> }
}

export interface RoutingDecision {
  /** Whether the turn should be delegated to an external agent. */
  shouldDelegate: boolean
  /** Target external-agent id when delegating. */
  targetAgentId?: string
  /** Id of the rule that matched. */
  matchedRuleId?: string
  /** Human-readable name of the matched rule (for the UI badge). */
  matchedRuleName?: string
  /** Human-readable reason for the decision. */
  reason?: string
  /** Machine-readable branch reason code. */
  reasonCode?: ExternalAgentBranchReasonCode
  /** The prompt actually sent downstream (post-PII when redaction is on). */
  filteredPrompt: string
  /** Placeholder→original map when redaction substituted PII. */
  redactionMap?: Record<string, RedactionRecord>
}

/**
 * Decide whether a turn delegates to an external agent and, if so, produce the
 * (optionally PII-filtered) prompt to send. Never throws: a matcher that finds
 * no rule yields `{ shouldDelegate: false }` with the raw prompt so the caller
 * runs the built-in path.
 */
export function routeDelegation(
  input: RouteDelegationInput,
  deps: RouteDelegationDeps
): RoutingDecision {
  const decision = deps.checkDelegation(input.prompt, input.context)

  if (!decision.shouldDelegate || !decision.targetAgentId) {
    return {
      shouldDelegate: false,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      filteredPrompt: input.prompt,
    }
  }

  let filteredPrompt = input.prompt
  let redactionMap: Record<string, RedactionRecord> | undefined
  if (deps.redact) {
    const { redacted, map } = deps.redact(input.prompt)
    filteredPrompt = redacted
    if (Object.keys(map).length > 0) redactionMap = map
  }

  return {
    shouldDelegate: true,
    targetAgentId: decision.targetAgentId,
    matchedRuleId: decision.matchedRule?.id,
    matchedRuleName: decision.matchedRule?.name,
    reason: decision.reason,
    reasonCode: decision.reasonCode,
    filteredPrompt,
    ...(redactionMap ? { redactionMap } : {}),
  }
}
