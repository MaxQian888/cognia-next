// Router + Fusion (ADR-0188) envelope mode as Claude Agent SDK hooks. The gate
// itself is engine-neutral (`../common/call-ledger-gate.ts`); only this hook
// shape is the SDK's, so it lives with the Claude engine (ADR-0217).

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk"

import type { CallLedgerGate, CallRefusal } from "../common/call-ledger-gate.ts"

/**
 * Envelope mode (the Claude Agent SDK loops internally, so calls cannot be
 * reserved one by one): before every tool use the renderer checks that the run
 * may still continue — not frozen, under its call limit, before its deadline,
 * with budget left. A refusal denies the tool and stops the query, so the SDK
 * makes no further model calls on this run.
 */
export function buildLedgerToolHooks({
  gate,
  onRefused,
}: {
  gate: CallLedgerGate
  onRefused(refusal: CallRefusal): void
}): { PreToolUse: HookCallbackMatcher[] } | undefined {
  if (!gate.active) return undefined
  let checks = 0
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (!gate.active) return {}
            checks += 1
            const outcome = await gate.reserve({
              kind: "envelope_check",
              logicalStepId: `tool:${checks}`,
              ...("tool_name" in input && typeof input.tool_name === "string"
                ? { toolName: input.tool_name }
                : {}),
            })
            if (outcome.decision !== "refused") return {}
            onRefused(outcome)
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: `Router + Fusion stopped this run: ${outcome.code}`,
              },
            }
          },
        ],
      },
    ],
  }
}
