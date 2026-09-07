/**
 * The guard loop every renderer-side trigger runner needs.
 *
 * `desktop-event-trigger`, `pet-event-trigger` and `issue-event-trigger` each
 * carry their own copy of it: look the kind up in the subscription index,
 * skip a workflow already running, skip one inside its cooldown, dispatch,
 * and isolate each match so one bad workflow cannot block its siblings. This
 * is that loop, once, for the runners added alongside it. The three older ones
 * are untouched, because rewriting a working guard is not what this change is
 * for.
 *
 * The in-flight guard is stronger than it looks. `dispatchTrigger` awaits the
 * whole run (`execution-authority.ts` ends with `return await driving`), so
 * the window it holds spans the run rather than a few milliseconds. Every side
 * effect a run produces lands inside its own window, which is what makes a
 * self-feeding trigger structurally impossible rather than merely unlikely.
 */

import { loggers } from "@cognia/logging"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import type { TriggerMatchContext } from "./trigger-subscriptions"

const log = loggers.scheduler

export const DEFAULT_TRIGGER_COOLDOWN_MS = 2_000

/** Chain-depth ceiling, shared with `workflow-completion-fanout`. */
export const MAX_TRIGGER_CHAIN_DEPTH = 10

export interface TriggerFanOutState {
  lastFired: Map<string, number>
  inflight: Set<string>
  now: () => number
  active: boolean
  unsubscribe?: () => void
}

export function createFanOutState(now: () => number = Date.now): TriggerFanOutState {
  return { lastFired: new Map(), inflight: new Set(), now, active: true }
}

export interface FanOutInput {
  state: TriggerFanOutState
  kind: WorkflowNodeKind
  match: TriggerMatchContext
  payload: Record<string, unknown>
  /**
   * Reject a match before it fires. Returning a string logs it as the reason,
   * which is how a self-trigger is refused: outright and visibly, rather than
   * left to a cooldown that only narrows the window.
   */
  reject?: (workflowId: string) => string | null
}

export async function fanOutTrigger(input: FanOutInput): Promise<number> {
  const { state, kind, match, payload } = input
  if (!state.active) return 0

  const [{ dispatchTrigger }, { findMatchingWorkflows }] = await Promise.all([
    import("./trigger-bridge"),
    import("./trigger-subscriptions"),
  ])
  const matches = findMatchingWorkflows(kind, match)
  if (matches.length === 0) return 0

  const chainDepth = typeof payload.chainDepth === "number" ? payload.chainDepth : 0
  if (chainDepth >= MAX_TRIGGER_CHAIN_DEPTH) {
    log.warn(`${kind}: chain depth ${chainDepth} reached the ceiling, not fanning out`)
    return 0
  }

  const now = state.now()
  let fired = 0
  await Promise.all(
    matches.map(async (candidate) => {
      const rejection = input.reject?.(candidate.workflowId)
      if (rejection) {
        log.warn(`${kind}: refused ${candidate.workflowId} (${rejection})`)
        return
      }
      if (state.inflight.has(candidate.workflowId)) return
      const cooldown =
        typeof candidate.params.cooldownMs === "number"
          ? candidate.params.cooldownMs
          : DEFAULT_TRIGGER_COOLDOWN_MS
      if (now - (state.lastFired.get(candidate.workflowId) ?? 0) < cooldown) return

      state.lastFired.set(candidate.workflowId, now)
      state.inflight.add(candidate.workflowId)
      fired += 1
      try {
        await dispatchTrigger({
          workflowId: candidate.workflowId,
          kind,
          triggerId: candidate.nodeId,
          payload: { ...payload, chainDepth: chainDepth + 1 },
          originAt: now,
        })
      } catch {
        // Per-match isolation: one bad workflow cannot block the others.
      } finally {
        state.inflight.delete(candidate.workflowId)
      }
    })
  )
  return fired
}

/** Stop a runner: mark it inactive and drop its bus subscription. */
export function disposeFanOut(state: TriggerFanOutState | null): void {
  if (!state) return
  state.active = false
  try {
    state.unsubscribe?.()
  } catch {
    // best-effort
  }
}
