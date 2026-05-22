"use client"

/**
 * Banner that surfaces an adapter whose outbound queue cap has tripped
 * recently. The cap (`OUTBOUND_QUEUE_SOFT_CAP`, default 5000) fires in
 * `enqueueOutbound` when the table overflows; each aged pending row emits
 * an `outbound.queue_capped` audit entry. When a single adapter accumulates
 * more than `SATURATION_THRESHOLD` of those entries inside the last 24
 * hours, this banner appears with a CTA to open the Outbound tab so the
 * operator can investigate / clear the backlog.
 *
 * Dismiss-per-set works the same way as `ConnectionLossBanner` but lives
 * in `sessionStorage` (separate key) — the failing-set is short-lived and
 * resets automatically once the underlying cap stops firing.
 */

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertOctagonIcon, ArrowRightIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry } from "@/types/connectors/audit"

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
const SATURATION_THRESHOLD = 100
const DISMISS_KEY = "inbox.outboundSaturationBanner.dismiss"
const DISMISS_TTL_MS = 30 * 60 * 1000

interface SaturatedAdapter {
  adapterId: string
  cappedCount: number
  lastAt: number
}

interface PersistedDismiss {
  hash: string
  at: number
}

function hashSet(ids: string[]): string {
  return ids.slice().sort().join("|")
}

function readDismiss(): PersistedDismiss | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedDismiss>
    if (typeof parsed.hash !== "string" || typeof parsed.at !== "number") return null
    return parsed as PersistedDismiss
  } catch {
    return null
  }
}

function writeDismiss(hash: string): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ hash, at: Date.now() } satisfies PersistedDismiss)
    )
  } catch {
    // Best-effort — Safari private mode rejects writes.
  }
}

export function OutboundSaturationBanner() {
  const t = useTranslations("inbox.banner.outboundSaturated")
  const [dismissed, setDismissed] = useState<PersistedDismiss | null>(() => readDismiss())

  // Live read of recent queue-capped audit rows. Window is small (24 h ×
  // N adapters), so JS-side group + threshold is faster than a per-adapter
  // live-query fan-out.
  const recent = useLiveQuery<AuditEntry[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .connectorAudit.where("at")
      .above(Date.now() - RECENT_WINDOW_MS)
      .filter((row) => row.kind === "outbound.queue_capped")
      .toArray()
  }, [])

  const saturated = useMemo<SaturatedAdapter[]>(() => {
    if (!recent || recent.length === 0) return []
    const byAdapter = new Map<string, SaturatedAdapter>()
    for (const row of recent) {
      const prior = byAdapter.get(row.adapterId)
      if (prior) {
        prior.cappedCount += 1
        if (row.at > prior.lastAt) prior.lastAt = row.at
      } else {
        byAdapter.set(row.adapterId, {
          adapterId: row.adapterId,
          cappedCount: 1,
          lastAt: row.at,
        })
      }
    }
    return Array.from(byAdapter.values())
      .filter((row) => row.cappedCount >= SATURATION_THRESHOLD)
      .sort((a, b) => b.lastAt - a.lastAt)
  }, [recent])

  const setHash = useMemo(() => hashSet(saturated.map((s) => s.adapterId)), [saturated])

  // Reset dismiss snapshot when the failing-set changes (one healed, another
  // tripped). Same compare-prev-during-render pattern as ConnectionLossBanner.
  const [trackedHash, setTrackedHash] = useState(setHash)
  if (trackedHash !== setHash) {
    setTrackedHash(setHash)
    if (dismissed && dismissed.hash !== setHash) {
      setDismissed(null)
    }
  }

  useEffect(() => {
    if (!dismissed) return
    const remaining = Math.max(0, dismissed.at + DISMISS_TTL_MS - Date.now())
    const id = window.setTimeout(() => setDismissed(null), remaining)
    return () => window.clearTimeout(id)
  }, [dismissed])

  if (saturated.length === 0) return null
  if (dismissed && dismissed.hash === setHash) return null

  const onDismiss = () => {
    writeDismiss(setHash)
    setDismissed({ hash: setHash, at: Date.now() })
  }

  return (
    <div
      data-testid="outbound-saturation-banner"
      role="alert"
      className="border-b border-rose-200/60 bg-rose-50/60 px-3 py-2 text-xs text-rose-900 dark:border-rose-800/60 dark:bg-rose-950/30 dark:text-rose-100"
    >
      <div className="flex items-start gap-2">
        <AlertOctagonIcon
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-700 dark:text-rose-300"
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <p className="font-medium" data-testid="outbound-saturation-banner-headline">
            {t("headline", { count: saturated.length })}
          </p>
          <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {saturated.map((adapter) => (
              <li
                key={adapter.adapterId}
                className="flex items-center gap-1.5"
                data-testid={`outbound-saturation-row-${adapter.adapterId}`}
              >
                <span className="font-mono text-[11px]">{adapter.adapterId}</span>
                <span className="text-rose-800 dark:text-rose-200">
                  {t("count", { count: adapter.cappedCount })}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-1">
          <Button
            asChild
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            data-testid="outbound-saturation-view"
          >
            <Link href="/settings/connections?tab=outbound">
              {t("viewOutbound")}
              <ArrowRightIcon className="ml-1 h-3 w-3" aria-hidden />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onDismiss}
            aria-label={t("dismiss")}
            data-testid="outbound-saturation-dismiss"
          >
            <XIcon className="h-3 w-3" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
