"use client"

/**
 * Manual refresh button + a live "updated Ns ago" readout. The relative label
 * re-computes every second from its own interval (Date.now read only inside the
 * effect, never render). Pairs with `RefreshSelect` (auto-refresh cadence) in
 * the toolbar.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Pure elapsed-ms → { i18n key, count } bucket. Exported for tests. */
export function agoBucket(elapsedMs: number): { key: string; count: number } {
  const e = Math.max(0, elapsedMs)
  if (e < 5_000) return { key: "justNow", count: 0 }
  const sec = Math.floor(e / 1000)
  if (sec < 60) return { key: "secondsAgo", count: sec }
  const min = Math.floor(sec / 60)
  if (min < 60) return { key: "minutesAgo", count: min }
  return { key: "hoursAgo", count: Math.floor(min / 60) }
}

export interface RefreshStatusProps {
  /** Epoch ms of the last data refresh; null before the first tick. */
  lastUpdated: number | null
  onRefresh: () => void
  /**
   * Drop the "updated Ns ago" label, keeping the button. Narrow toolbars only —
   * and driven by the caller's measured container, not the `sm:` viewport
   * breakpoint this used to rely on: a 390px pane inside a 1500px window kept
   * the label and pushed the row onto a third line.
   */
  compact?: boolean
}

export function RefreshStatus({ lastUpdated, onRefresh, compact = false }: RefreshStatusProps) {
  const t = useTranslations("observability.refresh")
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    // First stamp deferred to a macrotask so it isn't a synchronous setState in
    // the effect body (cascading-render lint); then refresh the label each second.
    const stamp = () => setNow(Date.now())
    const first = setTimeout(stamp, 0)
    const id = setInterval(stamp, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [])

  let label = ""
  if (lastUpdated !== null && now !== null) {
    const { key, count } = agoBucket(now - lastUpdated)
    label = t(key, { count })
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        className="px-2"
        data-testid="manual-refresh"
        aria-label={t("refreshNow")}
        title={t("refreshNow")}
      >
        <RefreshCwIcon className="size-3.5" />
      </Button>
      {label && !compact && (
        <span className="text-[11px] tabular-nums text-muted-foreground" data-testid="last-updated">
          {label}
        </span>
      )}
    </div>
  )
}
