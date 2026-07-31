/**
 * Advisory daily-budget toast (deduped once per provider per local day).
 *
 * The routing engine flags `overBudgetWarning` on a send when the selected
 * provider is past its `dailyCostBudget` but was the only viable candidate.
 * Budgets are advisory — the send proceeds — so the only UX is a polite,
 * non-spammy warning. Dedupe lives here (module scope) instead of in the
 * engine so the engine stays pure/synchronous.
 */

import { toast } from "sonner"

import { localDayString } from "@/lib/db/provider-cost-daily"

export interface OverBudgetWarning {
  providerId: string
  spend: number
  budget: number
}

const shownKeys = new Set<string>()

/**
 * Show the over-budget toast at most once per `${localDay}|${providerId}`.
 * Returns true when a toast was actually shown. `translate` receives
 * formatted values so the caller binds its own next-intl scope.
 */
export function notifyOverBudgetOnce(
  warning: OverBudgetWarning | undefined,
  translate: (values: { provider: string; spend: string; budget: string }) => string,
  now?: number
): boolean {
  if (!warning) return false
  const key = `${localDayString(now)}|${warning.providerId}`
  if (shownKeys.has(key)) return false
  shownKeys.add(key)
  try {
    toast.warning(
      translate({
        provider: warning.providerId,
        spend: warning.spend.toFixed(2),
        budget: warning.budget.toFixed(2),
      }),
      { duration: 6000 }
    )
  } catch {
    // Toast failures are non-fatal.
  }
  return true
}

export function __resetOverBudgetToastForTesting(): void {
  shownKeys.clear()
}
