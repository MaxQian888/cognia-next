/**
 * Plugin Agent SDK — cumulative run budget (Package F).
 *
 * ADR-0090 Phase 7: the token LEDGER lives in the one `RunBudgetGovernor`
 * (a per-session governor with a silent notifier) instead of a private
 * counter — plugin budgets are no longer a duplicate accounting system. The
 * public `PluginBudget` API (record/exhausted/assertWithin/status and the
 * `>= max` exhaustion semantic) is unchanged; the USD cap stays local (the
 * governor ledgers tokens only).
 */

import { createRunBudgetGovernor } from "@/lib/ai/agent/execution/run-budget-governor"
import type { TeamNotifier } from "@/lib/ai/agent/team/team-notifier"

export interface PluginBudgetOptions {
  /** Cumulative token cap (0 / undefined = unlimited). */
  maxTokens?: number
  /** Cumulative USD cap (0 / undefined = unlimited). */
  maxBudgetUsd?: number
}

export interface PluginBudgetUsage {
  totalTokens?: number
  costUsd?: number
}

export interface PluginBudgetStatus {
  usedTokens: number
  usedUsd: number
  maxTokens?: number
  maxBudgetUsd?: number
  exhausted: boolean
}

/** Thrown by `assertWithin` when a budget is already exhausted. */
export class PluginBudgetExceededError extends Error {
  constructor(
    readonly status: PluginBudgetStatus,
    message: string
  ) {
    super(message)
    this.name = "PluginBudgetExceededError"
  }
}

export interface PluginBudget {
  /** Add a turn's usage to the running totals. */
  record(usage: PluginBudgetUsage): void
  /** True when either cap has been reached. */
  exhausted(): boolean
  /** Throw {@link PluginBudgetExceededError} when exhausted; otherwise no-op. */
  assertWithin(): void
  status(): PluginBudgetStatus
}

/** Notifier that swallows everything — plugin budgets have no team surface. */
const SILENT_NOTIFIER = {
  notify: () => {},
  suspend: () => {},
  resume: () => {},
} as unknown as TeamNotifier

let pluginBudgetCounter = 0

/** Create a cumulative budget tracker. With no caps it never reports exhausted. */
export function createPluginBudget(options: PluginBudgetOptions = {}): PluginBudget {
  let usedUsd = 0
  const maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : undefined
  const maxBudgetUsd =
    options.maxBudgetUsd && options.maxBudgetUsd > 0 ? options.maxBudgetUsd : undefined

  // The ONE token ledger (ADR-0090 Phase 7). Exhaustion semantics stay this
  // module's own (`>= max`, not the guard's 95% critical threshold).
  pluginBudgetCounter += 1
  const governor = createRunBudgetGovernor({
    runId: `plugin-budget-${pluginBudgetCounter}`,
    limit: maxTokens ?? 0,
    onCritical: "notify",
    notifier: SILENT_NOTIFIER,
  })
  const account = governor.allocate("session")
  const usedTokens = (): number => governor.totals().usedTokens

  const exhausted = (): boolean =>
    (maxTokens !== undefined && usedTokens() >= maxTokens) ||
    (maxBudgetUsd !== undefined && usedUsd >= maxBudgetUsd)

  const status = (): PluginBudgetStatus => ({
    usedTokens: usedTokens(),
    usedUsd,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    exhausted: exhausted(),
  })

  return {
    record: (usage) => {
      if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
        account.add({ promptTokens: 0, completionTokens: 0, totalTokens: usage.totalTokens })
      }
      if (typeof usage.costUsd === "number" && usage.costUsd > 0) {
        usedUsd += usage.costUsd
      }
    },
    exhausted,
    assertWithin: () => {
      if (exhausted()) {
        throw new PluginBudgetExceededError(
          status(),
          `agent budget exhausted (tokens ${usedTokens()}/${maxTokens ?? "∞"}, usd ${usedUsd.toFixed(4)}/${maxBudgetUsd ?? "∞"})`
        )
      }
    },
    status,
  }
}
