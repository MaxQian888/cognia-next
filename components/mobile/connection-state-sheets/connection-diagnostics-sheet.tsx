"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"
import type { SyncableTable } from "@/lib/sync/types"
import { transport } from "@/lib/tauri"
import type { TransportTier } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

/**
 * Local mirror of the private `SyncState` shape in `companion-sync.ts`.
 * Kept in sync by hand — the source type isn't exported because callers
 * outside the sync orchestrator usually shouldn't mutate cursor state.
 */
interface SyncState {
  lastSyncAt: number | null
  since: number
  lastError: string | null
}

/**
 * Mobile-side diagnostics sheet: WebRTC tier indicator + per-table sync
 * progress. Opened from `ConnectionStateBadge` on Capacitor (mobile only;
 * desktop already has the full `WebRtcCard` in Settings).
 *
 * - **Tier row** — shows the active transport tier (rtc-direct / rtc-relay
 *   / ws-lan / ws-tunnel / offline) with the same colour palette as the
 *   desktop card so users can mentally cross-reference. The "Reconnect"
 *   button drives `reconnectRtc()` and surfaces the same throttled/no-tier
 *   feedback as the badge dropdown.
 *
 * - **Sync table** — iterates the 9 syncable Dexie tables (Wave 4 ADR-0027)
 *   showing `lastSyncAt`, `since` cursor, and the most recent error. Each
 *   row has a "Retry" button that kicks `runSyncDown({ only: [table] })`.
 *   Top "Sync all" button re-runs the full handler list.
 */

export interface ConnectionDiagnosticsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SYNC_TABLES: readonly SyncableTable[] = [
  "sessions",
  "messages",
  "characters",
  "skills",
  "workflows",
  "twinProfile",
  "plugins",
  "adapterInstances",
  "settings",
]

const TIER_TONES: Record<TransportTier, string> = {
  "rtc-direct": "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "rtc-relay": "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "ws-lan": "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "ws-tunnel": "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  offline: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
}

export function ConnectionDiagnosticsSheet({
  open,
  onOpenChange,
}: ConnectionDiagnosticsSheetProps) {
  const t = useTranslations("mobile.connectionDiagnostics")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))
  const tShared = useTranslations("mobile.connectionState")
  const [tier, setTier] = useState<TransportTier>("offline")
  const [states, setStates] = useState<Record<SyncableTable, SyncState>>(() => snapshotSyncStates())
  const [syncing, setSyncing] = useState<Record<SyncableTable, boolean>>({} as never)
  const [busy, setBusy] = useState(false)

  // Subscribe to tier changes only while the sheet is open — avoids
  // keeping a closure alive on the rest of the app surface.
  // `onTierChange` seeds the listener with the current value on subscribe,
  // so we don't have to call `getActiveTier()` separately (which would be
  // a sync setState-in-effect violation).
  useEffect(() => {
    if (!open) return
    const tx = transport as unknown as {
      onTierChange?: (h: (t: TransportTier) => void) => () => void
    }
    return tx.onTierChange?.((next) => setTier(next))
  }, [open])

  // Refresh the snapshot once per second while open — the orchestrator
  // mutates the underlying map fire-and-forget so we can't subscribe to
  // it directly without changes elsewhere. 1Hz is cheap and good enough;
  // the initial snapshot is seeded by the lazy useState above.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setStates(snapshotSyncStates()), 1_000)
    return () => window.clearInterval(id)
  }, [open])

  const onReconnect = useCallback(async () => {
    const tx = transport as unknown as {
      reconnectRtc?: () => "ok" | "busy" | "no-tier" | "throttled"
    }
    const outcome = tx.reconnectRtc?.() ?? "no-tier"
    if (outcome === "throttled") {
      toast.info(tShared("toasts.reconnectThrottled"))
    } else if (outcome === "busy") {
      toast.info(tShared("toasts.reconnectBusy"))
    } else if (outcome === "ok") {
      toast.success(tShared("toasts.reconnectStarted"))
    } else {
      toast.message(t("noTierToast"))
    }
  }, [t, tShared])

  const onSyncAll = useCallback(async () => {
    setBusy(true)
    try {
      await runSyncDown()
      setStates(snapshotSyncStates())
      toast.success(tShared("toasts.syncKicked"))
    } catch (err) {
      toast.error(
        tShared("toasts.syncFailed", {
          message: err instanceof Error ? err.message : "",
        })
      )
    } finally {
      setBusy(false)
    }
  }, [tShared])

  const onSyncOne = useCallback(
    async (table: SyncableTable) => {
      setSyncing((s) => ({ ...s, [table]: true }))
      try {
        await runSyncDown({ only: [table] })
        setStates(snapshotSyncStates())
      } catch (err) {
        toast.error(
          tShared("toasts.syncFailed", {
            message: err instanceof Error ? err.message : "",
          })
        )
      } finally {
        setSyncing((s) => ({ ...s, [table]: false }))
      }
    },
    [tShared]
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[80dvh] gap-0 p-0"
        data-testid="connection-diagnostics-sheet"
      >
        <SheetHeader className="px-4 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ActivityIcon className="size-4" aria-hidden="true" />
            {t("title")}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          {/* Tier row */}
          <section className="mb-4 rounded-md border p-3" data-testid="diagnostics-tier-row">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{t("tierLabel")}</span>
              <Badge
                variant="outline"
                role="status"
                className={cn(
                  "gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase",
                  TIER_TONES[tier]
                )}
                data-testid={`diagnostics-tier-${tier}`}
              >
                <CircleIcon className="size-2 fill-current" aria-hidden="true" />
                {t(`tier.${tier}`)}
              </Badge>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground">{t(`tierHint.${tier}`)}</p>
            <Button
              variant="outline"
              size="sm"
              className="touch-target w-full"
              onClick={() => void onReconnect()}
              data-testid="diagnostics-reconnect"
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              {t("reconnectButton")}
            </Button>
          </section>

          {/* Sync header */}
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">{t("syncLabel")}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5"
              onClick={() => void onSyncAll()}
              disabled={busy}
              data-testid="diagnostics-sync-all"
            >
              <RefreshCwIcon
                className={cn("size-3.5", busy && "animate-spin")}
                aria-hidden="true"
              />
              {t("syncAllButton")}
            </Button>
          </div>

          <ul className="flex flex-col gap-1.5" data-testid="diagnostics-sync-list">
            {SYNC_TABLES.map((table) => {
              const s = states[table] ?? { lastSyncAt: null, since: 0, lastError: null }
              return (
                <SyncRow
                  key={table}
                  table={table}
                  state={s}
                  syncing={syncing[table] ?? false}
                  onRetry={() => void onSyncOne(table)}
                  t={t}
                />
              )
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface SyncRowProps {
  table: SyncableTable
  state: SyncState
  syncing: boolean
  onRetry: () => void
  t: ReturnType<typeof useTranslations>
}

function SyncRow({ table, state, syncing, onRetry, t }: SyncRowProps) {
  const hasError = !!state.lastError
  const hasSynced = state.lastSyncAt !== null
  return (
    <li
      className={cn(
        "flex items-center justify-between gap-2 rounded border px-3 py-2",
        hasError ? "border-destructive/40 bg-destructive/5" : "bg-card"
      )}
      data-testid={`diagnostics-sync-row-${table}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {hasError ? (
            <AlertCircleIcon className="size-3 text-destructive" aria-hidden="true" />
          ) : hasSynced ? (
            <CheckCircle2Icon className="size-3 text-emerald-500" aria-hidden="true" />
          ) : (
            <CircleIcon className="size-3 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate font-mono text-xs">{table}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>
            {t("rowSince")}: {state.since}
          </span>
          {state.lastSyncAt ? (
            <span>· {new Date(state.lastSyncAt).toLocaleTimeString()}</span>
          ) : (
            <span>· {t("rowNever")}</span>
          )}
        </div>
        {hasError ? (
          <span className="truncate text-[10px] text-destructive">{state.lastError}</span>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-[10px]"
        onClick={onRetry}
        disabled={syncing}
        data-testid={`diagnostics-sync-retry-${table}`}
      >
        <RefreshCwIcon className={cn("size-3", syncing && "animate-spin")} aria-hidden="true" />
        {t("rowRetry")}
      </Button>
    </li>
  )
}
