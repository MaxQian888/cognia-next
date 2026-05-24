"use client"

/**
 * Inbox top banner that surfaces adapters in `degraded` or `down` state
 * so operators don't have to open Settings to notice a transport failure.
 *
 * Reads recent heartbeat rows from the dedicated `connectorHeartbeats` table
 * (v51; last 5 min) and groups by adapterId, keeping only the newest snapshot. Adapters
 * whose latest heartbeat state is `running` or `starting` are filtered
 * out — only the truly stuck ones surface.
 *
 * Dismiss is per-set: the hash of the affected adapter ids is recorded
 * in sessionStorage so the same set of failures doesn't bounce back
 * after dismiss; if the failing-set changes (one heals, another drops)
 * the banner re-appears with the new content.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon, LoaderIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import { requeueAdapter } from "@/lib/connectors/lifecycle"
import { isTauri } from "@/lib/tauri"
import type { ConnectorHeartbeatRow } from "@/lib/db/connector-types"

const RECENT_WINDOW_MS = 5 * 60 * 1000
const DISMISS_KEY = "inbox.connectionLossBanner.dismiss"
const DISMISS_TTL_MS = 30 * 60 * 1000

interface DegradedAdapter {
  adapterId: string
  state: "degraded" | "down"
  reason: string | null
  at: number
}

interface PersistedDismiss {
  hash: string
  at: number
}

/**
 * Stable hash of the affected adapter-id set so we can compare dismiss
 * payloads even when adapters arrive in different orders.
 */
function hashSet(ids: string[]): string {
  return ids.slice().sort().join("|")
}

/**
 * v49 — persist the dismiss snapshot in `localStorage` instead of
 * `sessionStorage` so a tab reload (or app cold-start) doesn't rebroadcast
 * the same failure set. TTL still kicks in via the existing timer; once
 * the snapshot ages past 30 minutes it's cleared on next render.
 *
 * localStorage was chosen over a Dexie settings field because the read
 * needs to be synchronous (the initial render decides whether to mount
 * the banner) and the value is single-user, single-device by design — no
 * benefit from companion-sync mirroring.
 */
function readDismiss(): PersistedDismiss | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
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
    window.localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ hash, at: Date.now() } satisfies PersistedDismiss)
    )
  } catch {
    // Best-effort — Safari private mode rejects writes.
  }
}

function clearDismiss(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(DISMISS_KEY)
  } catch {
    // Best-effort.
  }
}

export function ConnectionLossBanner() {
  const t = useTranslations("inbox.connectionLoss")
  const [reconnecting, setReconnecting] = useState<Set<string>>(() => new Set())
  const [dismissed, setDismissed] = useState<PersistedDismiss | null>(() => readDismiss())

  // Live read of recent heartbeats from the dedicated table (v51) — the whole
  // table is heartbeats, so the `at`-range scan needs no `kind` filter. The
  // window is small (5 min × N adapters, N ≤ 10), so group in JS.
  const recent = useLiveQuery<ConnectorHeartbeatRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .connectorHeartbeats.where("at")
      .above(Date.now() - RECENT_WINDOW_MS)
      .toArray()
  }, [])

  const degraded = useMemo<DegradedAdapter[]>(() => {
    if (!recent || recent.length === 0) return []
    const newestByAdapter = new Map<string, (typeof recent)[number]>()
    for (const row of recent) {
      const prior = newestByAdapter.get(row.adapterId)
      if (!prior || prior.at < row.at) newestByAdapter.set(row.adapterId, row)
    }
    const out: DegradedAdapter[] = []
    for (const row of newestByAdapter.values()) {
      const state = (row.fields?.state as string | undefined) ?? "running"
      if (state !== "degraded" && state !== "down") continue
      out.push({
        adapterId: row.adapterId,
        state: state as "degraded" | "down",
        reason: (row.fields?.reason as string | undefined) ?? row.reason ?? null,
        at: row.at,
      })
    }
    return out.sort((a, b) => b.at - a.at)
  }, [recent])

  const setHash = useMemo(() => hashSet(degraded.map((d) => d.adapterId)), [degraded])

  // Reset the dismiss snapshot the moment the failing-set hash changes —
  // React 19 compare-prev-during-render pattern keeps this out of
  // `useEffect` (rule `react-hooks/set-state-in-effect`).
  const [trackedHash, setTrackedHash] = useState(setHash)
  if (trackedHash !== setHash) {
    setTrackedHash(setHash)
    if (dismissed && dismissed.hash !== setHash) {
      setDismissed(null)
      // v49 — also clear the persisted snapshot so the next mount doesn't
      // re-hide for an already-changed failing set.
      clearDismiss()
    }
  }

  // TTL countdown — schedule a one-shot clear so the timer callback (not
  // the effect body) issues the setState. Re-runs when `dismissed` flips
  // to a fresh snapshot.
  useEffect(() => {
    if (!dismissed) return
    const remaining = Math.max(0, dismissed.at + DISMISS_TTL_MS - Date.now())
    const id = window.setTimeout(() => {
      setDismissed(null)
      // Drop the persisted snapshot so a tab reload at exactly the TTL
      // boundary doesn't re-hide for the now-stale failure set.
      clearDismiss()
    }, remaining)
    return () => window.clearTimeout(id)
  }, [dismissed])

  if (degraded.length === 0) return null
  if (dismissed && dismissed.hash === setHash) return null

  const onDismiss = () => {
    writeDismiss(setHash)
    setDismissed({ hash: setHash, at: Date.now() })
  }

  const onReconnectOne = async (adapterId: string) => {
    if (!isTauri()) {
      toast.error(t("reconnectDesktopOnly"))
      return
    }
    setReconnecting((prev) => {
      const next = new Set(prev)
      next.add(adapterId)
      return next
    })
    try {
      const ok = await requeueAdapter(adapterId)
      if (ok) toast.success(t("reconnectQueued"))
      else toast.error(t("reconnectUnavailable"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting((prev) => {
        const next = new Set(prev)
        next.delete(adapterId)
        return next
      })
    }
  }

  const onReconnectAll = async () => {
    for (const adapter of degraded) {
      // Best-effort — kick each in parallel but track individually.
      void onReconnectOne(adapter.adapterId)
    }
  }

  return (
    <div
      data-testid="connection-loss-banner"
      role="alert"
      className="border-b border-amber-200/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <p className="font-medium" data-testid="connection-loss-banner-headline">
            {t("headline", { count: degraded.length })}
          </p>
          <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {degraded.map((adapter) => (
              <li
                key={adapter.adapterId}
                className="flex items-center gap-1.5"
                data-testid={`connection-loss-row-${adapter.adapterId}`}
              >
                <span className="font-mono text-[11px]">{adapter.adapterId}</span>
                <span className="text-amber-800 dark:text-amber-200">
                  {t(`state.${adapter.state}`)}
                </span>
                {adapter.reason && (
                  <span className="text-amber-700/80 dark:text-amber-300/80">
                    — {adapter.reason}
                  </span>
                )}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-5 px-1 text-[11px] text-amber-900 underline dark:text-amber-100"
                  disabled={reconnecting.has(adapter.adapterId) || !isTauri()}
                  onClick={() => void onReconnectOne(adapter.adapterId)}
                  data-testid={`connection-loss-reconnect-${adapter.adapterId}`}
                >
                  {reconnecting.has(adapter.adapterId) ? (
                    <LoaderIcon className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCwIcon className="mr-1 h-3 w-3" aria-hidden />
                  )}
                  {t("reconnect")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-1">
          {degraded.length > 1 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void onReconnectAll()}
              disabled={!isTauri()}
              data-testid="connection-loss-reconnect-all"
            >
              {t("reconnectAll")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onDismiss}
            aria-label={t("dismiss")}
            data-testid="connection-loss-dismiss"
          >
            <XIcon className="h-3 w-3" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
