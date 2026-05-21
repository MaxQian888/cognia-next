"use client"

/**
 * Full-page sync status panel for `/me/sync`. Mirrors the per-table
 * snapshot that `<ConnectionDiagnosticsSheet>` renders, but full-screen
 * and with per-row "Sync now" retry buttons.
 *
 * Live data: `snapshotSyncStates()` is in-memory state managed by the
 * companion sync orchestrator. We re-read it on a one-second tick while
 * mounted so the "lastSyncAt" stamp stays fresh — the orchestrator does
 * not (yet) expose a subscription API.
 */

import { Fragment, useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { TransportTierIndicator } from "./transport-tier-indicator"
import { runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"
import { formatRelative } from "@/lib/time/relative"

type Snapshot = ReturnType<typeof snapshotSyncStates>

function useSyncSnapshot(intervalMs = 1000): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshotSyncStates())
  useEffect(() => {
    const id = setInterval(() => {
      setSnapshot(snapshotSyncStates())
    }, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return snapshot
}

export interface SyncStatusPanelProps {
  /** Override the snapshot reader (tests). */
  reader?: () => Snapshot
  /** Override the sync trigger (tests). */
  trigger?: (only?: readonly (keyof Snapshot)[]) => Promise<unknown>
}

export function SyncStatusPanel({ reader, trigger }: SyncStatusPanelProps = {}) {
  const t = useTranslations("mobile.me.sync")
  const liveSnapshot = useSyncSnapshot()
  const snapshot = reader ? reader() : liveSnapshot
  const [busy, setBusy] = useState<keyof Snapshot | "all" | null>(null)

  const onSync = useCallback(
    async (only?: keyof Snapshot) => {
      const target = only ?? "all"
      setBusy(target)
      try {
        const runner =
          trigger ?? ((scope?: readonly (keyof Snapshot)[]) => runSyncDown({ only: scope }))
        await runner(only ? [only] : undefined)
        toast.success(only ? t("toastTableSynced", { table: only }) : t("toastAllSynced"))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toastError", { reason: message }))
      } finally {
        setBusy(null)
      }
    },
    [t, trigger]
  )

  const tables = Object.keys(snapshot) as (keyof Snapshot)[]

  return (
    <div className="flex flex-col gap-4" data-testid="sync-status-panel">
      <TransportTierIndicator />
      <Card>
        <CardContent className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium">{t("title")}</h2>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void onSync()}
              data-testid="sync-status-run-all"
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={"size-3.5" + (busy === "all" ? " animate-spin" : "")}
              />
              {t("syncAll")}
            </Button>
          </div>
          <ItemGroup className="rounded-md border" aria-label={t("title")}>
            {tables.map((table, idx) => {
              const state = snapshot[table]
              const lastSynced = state.lastSyncAt
                ? formatRelative(state.lastSyncAt)
                : t("neverSynced")
              return (
                <Fragment key={table}>
                  {idx > 0 ? <ItemSeparator /> : null}
                  <Item size="sm" className="px-3 py-2" data-testid={`sync-row-${table}`}>
                    <ItemContent>
                      <ItemTitle className="text-sm capitalize">{table}</ItemTitle>
                      {state.lastError ? (
                        <ItemDescription className="text-xs text-destructive">
                          {state.lastError}
                        </ItemDescription>
                      ) : (
                        <ItemDescription className="text-xs">
                          {t("lastSynced", { time: lastSynced })}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void onSync(table)}
                        aria-label={t("syncRowAria", { table })}
                        data-testid={`sync-row-retry-${table}`}
                      >
                        <RefreshCwIcon
                          aria-hidden="true"
                          className={"size-3.5" + (busy === table ? " animate-spin" : "")}
                        />
                      </Button>
                    </ItemActions>
                  </Item>
                </Fragment>
              )
            })}
          </ItemGroup>
        </CardContent>
      </Card>
    </div>
  )
}
