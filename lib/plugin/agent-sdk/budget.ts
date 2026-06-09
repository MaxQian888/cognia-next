/**
 * Plugin Agent SDK — cumulative run budget (Package F).
 *
 * A lightweight token/cost tracker for plugin agent sessions, mirroring the
 * team `BudgetGuard` concept but standalone (no notifier / concurrency
 * coupling). The session runtime records each turn's usage and asserts headroom
 * before the next turn — throwing {@link PluginBudgetExceededError} when the
 * budget is exhausted.
 */

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

/** Create a cumulative budget tracker. With no caps it never reports exhausted. */
export function createPluginBudget(options: PluginBudgetOptions = {}): PluginBudget {
  let usedTokens = 0
  let usedUsd = 0
  const maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : undefined
  const maxBudgetUsd =
    options.maxBudgetUsd && options.maxBudgetUsd > 0 ? options.maxBudgetUsd : undefined

  const exhausted = (): boolean =>
    (maxTokens !== undefined && usedTokens >= maxTokens) ||
    (maxBudgetUsd !== undefined && usedUsd >= maxBudgetUsd)

  const status = (): PluginBudgetStatus => ({
    usedTokens,
    usedUsd,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    exhausted: exhausted(),
  })

  return {
    record: (usage) => {
      if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
        usedTokens += usage.totalTokens
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
          `agent budget exhausted (tokens ${usedTokens}/${maxTokens ?? "∞"}, usd ${usedUsd.toFixed(4)}/${maxBudgetUsd ?? "∞"})`
        )
      }
    },
    status,
  }
}
