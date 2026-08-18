"use client"

/**
 * Warning chip for provider spans that were emitted but never persisted.
 *
 * `lib/claude/provider-telemetry.ts` drops a provider span when the caller did
 * not thread a `traceId`, increments `missingTraceContextCount`, and (in dev
 * only) logs a warning. That counter was exported but read by nothing, so in a
 * production build the loss was completely silent: the waterfall simply showed
 * fewer spans than calls actually happened, with no way to tell an idle period
 * from an instrumentation gap.
 *
 * The count is a module-level counter, not reactive state, so it is polled on
 * the dashboard's own refresh tick rather than subscribed to.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { TriangleAlertIcon } from "lucide-react"
import { getMissingProviderTraceContextCount } from "@/lib/claude/provider-telemetry"

export interface DroppedSpansBadgeProps {
  /**
   * Changes on every dashboard refresh; re-reads the counter. The value itself
   * is unused — it only serves as the poll trigger.
   */
  refreshKey: number | null
}

export function DroppedSpansBadge({ refreshKey }: DroppedSpansBadgeProps) {
  const t = useTranslations("observability.droppedSpans")
  const [count, setCount] = useState(0)

  useEffect(() => {
    // Deferred to a macrotask so this is not a synchronous setState in the
    // effect body (the repo's cascading-render lint rule).
    const id = setTimeout(() => setCount(getMissingProviderTraceContextCount()), 0)
    return () => clearTimeout(id)
  }, [refreshKey])

  if (count <= 0) return null

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] tabular-nums text-amber-700 dark:text-amber-400"
      data-testid="dropped-spans-badge"
      title={t("tooltip", { count })}
      aria-label={t("tooltip", { count })}
    >
      <TriangleAlertIcon className="size-3" aria-hidden="true" />
      {t("label", { count })}
    </span>
  )
}
