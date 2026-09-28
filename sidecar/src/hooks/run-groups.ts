import type { HookOutcome, HookGroup, HooksConfig, HookDeps, HookDecision } from "./kernel/types.ts"
import { matcherMatches, agentsMatch } from "./matcher.ts"
import { emptyDecision, extractDecision, mergeOutcome } from "./kernel/decision.ts"
import { runHandler, applyFailurePolicy } from "./handlers/index.ts"
import { handlerPolicyClass } from "./kernel/types.ts"

function auditOutcome(outcome: HookOutcome) {
  if (outcome?.block) return "blocked"
  if (outcome?.warning) return "warning"
  if (outcome?.additionalContext) return "context"
  return "allowed"
}

/**
 * Groups configured for `eventName` that actually contain a handler.
 *
 * The emptiness filter used to be implicit: only three events were supported,
 * so a `Stop: [{ hooks: [] }]` entry was skipped for the wrong reason. Now that
 * every event is supported, "configured but empty" has to be rejected on its
 * own terms — registering a callback for it would run the whole matcher and
 * decision path on every fire to arrive at no decision.
 */
export function groupsForEvent(
  hooksConfig: HooksConfig | undefined,
  eventName: string
): HookGroup[] {
  const arr = hooksConfig ? hooksConfig[eventName] : undefined
  if (!Array.isArray(arr)) return []
  return arr.filter((g) => Array.isArray(g?.hooks) && g.hooks.length > 0)
}

/**
 * Run every matching handler for an event, folding into one decision.
 *
 * Handlers run in PARALLEL (matching Claude Code, where N matching hooks cost
 * max(runtime) not sum — this sits inside the canUseTool-blocking path), but
 * outcomes are merged in ARRAY order so the result is deterministic: first
 * block in config order wins, last mutation in config order wins.
 */
export async function runGroups(
  groups: readonly (HookGroup | null)[],
  target: string | null,
  payloadJson: string,
  signal?: AbortSignal,
  cwd?: string,
  deps: HookDeps = {}
): Promise<HookDecision> {
  const pending: Promise<HookOutcome>[] = []
  let handlerIndex = 0
  for (const group of groups) {
    if (!group || typeof group !== "object") continue
    if (
      target !== null &&
      !matcherMatches(
        group.matcher,
        target,
        deps.eventName === "FileChanged" || deps.eventName === "StopFailure"
      )
    )
      continue
    // Orthogonal to `matcher`: `matcher` narrows by tool, `agents` by producer.
    // Applies to EVERY event, including the matcher-less ones.
    if (!agentsMatch(group.agents, deps.agentIdentity)) continue
    for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
      const effectiveHandler =
        deps.eventName === "PreModelSwitch" && handler?.timeout === undefined
          ? { ...handler, timeout: 30 }
          : handler
      const index = handlerIndex++
      const startedAt = Date.now()
      pending.push(
        runHandler(effectiveHandler, payloadJson, signal, cwd, deps).then((rawOutcome) => {
          const normalized = rawOutcome?.pluginResult ?? rawOutcome
          const merged = {
            ...rawOutcome,
            ...extractDecision(normalized),
          }
          // `async` handlers are fire-and-forget: the detached path only ever
          // reports `{}` or `{ warning }`, and a managed policyClass must not
          // promote that spawn warning into a block — an async hook can never
          // participate in the decision.
          const outcome =
            handler?.type === "command" && handler?.async === true
              ? merged
              : applyFailurePolicy(handler, merged)
          if (deps.eventName === "PreModelSwitch" && /timed out/.test(outcome.warning ?? ""))
            outcome.block = "Model switch hook timed out"
          deps.onAudit?.({
            hookId: `${deps.sessionId ?? "session"}:${deps.eventName ?? "event"}:${startedAt}:${index}`,
            hookEvent: deps.eventName ?? "unknown",
            provider: deps.provider ?? "unknown",
            handlerType: handler?.type ?? "unknown",
            policyClass: handlerPolicyClass(handler),
            outcome: auditOutcome(outcome),
            latencyMs: Math.max(0, Date.now() - startedAt),
            redacted: ["http", "webhook", "prompt", "agent", "mcp_tool", "plugin"].includes(
              handler?.type ?? "unknown"
            ),
            blockReason: outcome?.block,
            error: outcome?.warning,
          })
          return outcome
        })
      )
    }
  }
  const dec = emptyDecision()
  for (const outcome of await Promise.all(pending)) {
    if (dec.block !== undefined) break // first block (in config order) wins
    mergeOutcome(dec, outcome)
  }
  return dec
}
