/**
 * Token budget tracker with four escalation actions.
 *
 * Per ADR-0022 §3.3. Listens to `add(usage)` calls from the team.task.dispatch
 * executor; fires `warning_crossed` / `critical_crossed` events once each per
 * run (until `extendLimit` resets thresholds). On `critical_crossed`, dispatches
 * one of four `onCritical` actions:
 *
 *   - notify: emit a critical notification, run continues
 *   - pause_for_review: emit pause_for_review event (synthesizer opens gate)
 *   - reduce_concurrency: concurrencyCtrl.reduceTo(1) + warn notification
 *   - handoff_to_background: concurrency=1 + modelPref.downshift() +
 *     notifier.suspend() + entered_background_mode event
 */

import type { TeamNotifier } from "./team-notifier"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { ModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import type { SubAgentTokenUsage, TeamBudgetEscalationAction } from "@/types/agent/agent-team"

export type BudgetEventName =
  | "warning_crossed"
  | "critical_crossed"
  | "pause_for_review"
  | "entered_background_mode"

export interface BudgetGuardOptions {
  runId: string
  /** Token budget; 0 = unlimited. */
  limit: number
  /** Warning threshold ratio (0–1). Default 0.80. */
  warnAt?: number
  /** Critical threshold ratio (0–1). Default 0.95. */
  critAt?: number
  /** One of the 4 ADR-0022 §3.3 escalation actions. */
  onCritical: TeamBudgetEscalationAction
  notifier: TeamNotifier
  concurrencyCtrl?: ConcurrencyController
  modelCtrl?: ModelPreferenceController
}

export interface BudgetGuardStatus {
  used: number
  limit: number
  level: "ok" | "warning" | "critical"
}

export interface BudgetGuard {
  add(usage: SubAgentTokenUsage): void
  status(): BudgetGuardStatus
  /** Extend the cap (HITL approve path). Resets warned/critical flags. */
  extendLimit(extraTokens: number): void
  on(event: BudgetEventName, cb: (payload: { runId: string }) => void): () => void
}

interface InternalListeners {
  warning_crossed: Set<(p: { runId: string }) => void>
  critical_crossed: Set<(p: { runId: string }) => void>
  pause_for_review: Set<(p: { runId: string }) => void>
  entered_background_mode: Set<(p: { runId: string }) => void>
}

export function createBudgetGuard(opts: BudgetGuardOptions): BudgetGuard {
  const warnAt = opts.warnAt ?? 0.8
  const critAt = opts.critAt ?? 0.95
  let limit = opts.limit
  let used = 0
  let warned = false
  let critical = false

  const listeners: InternalListeners = {
    warning_crossed: new Set(),
    critical_crossed: new Set(),
    pause_for_review: new Set(),
    entered_background_mode: new Set(),
  }

  const emit = (event: BudgetEventName): void => {
    for (const fn of listeners[event]) {
      try {
        fn({ runId: opts.runId })
      } catch (err) {
        console.warn(`BudgetGuard '${event}' listener threw:`, err)
      }
    }
  }

  const computeLevel = (): BudgetGuardStatus["level"] => {
    if (limit <= 0) return "ok"
    const ratio = used / limit
    if (ratio >= critAt) return "critical"
    if (ratio >= warnAt) return "warning"
    return "ok"
  }

  const handleCritical = (): void => {
    opts.notifier.notify({
      level: "critical",
      title: "Token budget critical",
      body: `Used ${used} of ${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`,
      runId: opts.runId,
      teamId: "",
      dedupeKey: `budget-critical:${opts.runId}`,
    })
    emit("critical_crossed")
    switch (opts.onCritical) {
      case "notify":
        // notification already sent above
        break
      case "pause_for_review":
        emit("pause_for_review")
        break
      case "reduce_concurrency":
        opts.concurrencyCtrl?.reduceTo(1)
        opts.notifier.notify({
          level: "warn",
          title: "Concurrency reduced to 1",
          body: "Budget critical; further tasks will serialize.",
          runId: opts.runId,
          teamId: "",
          dedupeKey: `budget-reduce:${opts.runId}`,
        })
        break
      case "handoff_to_background":
        opts.concurrencyCtrl?.reduceTo(1)
        opts.modelCtrl?.downshift()
        opts.notifier.suspend()
        emit("entered_background_mode")
        break
    }
  }

  return {
    add: (usage) => {
      const delta = usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
      used += delta
      if (limit <= 0) return
      const ratio = used / limit
      // Check thresholds independently — a single add() that jumps from 0 to
      // 96% must fire warning_crossed AND critical_crossed.
      if (ratio >= warnAt && !warned) {
        warned = true
        opts.notifier.notify({
          level: "warn",
          title: "Token budget warning",
          body: `Used ${used} of ${limit} tokens (${(ratio * 100).toFixed(1)}%)`,
          runId: opts.runId,
          teamId: "",
          dedupeKey: `budget-warning:${opts.runId}`,
        })
        emit("warning_crossed")
      }
      if (ratio >= critAt && !critical) {
        critical = true
        handleCritical()
      }
    },
    status: () => ({ used, limit, level: computeLevel() }),
    extendLimit: (extraTokens) => {
      limit += extraTokens
      warned = false
      critical = false
    },
    on: (event, cb) => {
      listeners[event].add(cb)
      return () => {
        listeners[event].delete(cb)
      }
    },
  }
}
