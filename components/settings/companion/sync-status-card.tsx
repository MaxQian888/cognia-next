"use client"

/**
 * Mobile companion → Sync Status card.
 *
 * Closes the "registered handlers without UI surface" gap (ADR-0027 Wave 4
 * registered five new sync handlers — `workflows`, `twinProfile`, `plugins`,
 * `adapterInstances`, `settings` — but the Companion section had no
 * affordance to inspect or trigger them). Per-row controls:
 *
 *   - lastSyncedAt (relative time) + cursor head (truncated)
 *   - lastError, surfaced in red when present
 *   - "Sync now" button: `runSyncDown({ only: [table] })`
 *
 * Plus a "Sync all" header action that mirrors the per-handler loop.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, LoaderIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SYNC_HANDLER_TABLES, runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"
import { formatRelative } from "@/lib/time/relative"
import { cn } from "@/lib/utils"
import type { SyncableTable } from "@/lib/sync/types"

interface SyncRowSnapshot {
  table: SyncableTable
  lastSyncAt: number | null
  since: number
  lastError: string | null
}

const POLL_INTERVAL_MS = 2_000

function snapshot(): SyncRowSnapshot[] {
  const states = snapshotSyncStates()
  return SYNC_HANDLER_TABLES.map((table) => {
    const state = states[table]
    return {
      table,
      lastSyncAt: state.lastSyncAt,
      since: state.since,
      lastError: state.lastError,
    }
  })
}

export function SyncStatusCard() {
  const t = useTranslations("mobile.companion.syncStatus")
  const [rows, setRows] = useState<SyncRowSnapshot[]>(() => snapshot())
  const [busy, setBusy] = useState<Set<SyncableTable> | "all" | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (cancelled) return
      setRows(snapshot())
      timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }
    refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const isBusy = useCallback(
    (table: SyncableTable) => {
      if (busy === "all") return true
      return busy instanceof Set && busy.has(table)
    },
    [busy]
  )

  const onSyncOne = useCallback(
    async (table: SyncableTable) => {
      setBusy((prev) => {
        const next = prev instanceof Set ? new Set(prev) : new Set<SyncableTable>()
        next.add(table)
        return next
      })
      try {
        const outcomes = await runSyncDown({ only: [table] })
        const outcome = outcomes[0]
        if (outcome?.ok) {
          toast.success(t("toastSyncOneOk", { table: t(`tableLabels.${table}`) }))
        } else if (outcome) {
          toast.error(
            t("toastSyncOneFail", {
              table: t(`tableLabels.${table}`),
              reason: outcome.failure.message,
            })
          )
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy((prev) => {
          if (!(prev instanceof Set)) return prev
          const next = new Set(prev)
          next.delete(table)
          return next.size === 0 ? null : next
        })
        setRows(snapshot())
      }
    },
    [t]
  )

  const onSyncAll = useCallback(async () => {
    setBusy("all")
    try {
      const outcomes = await runSyncDown()
      const failures = outcomes.filter((o) => !o.ok)
      if (failures.length === 0) {
        toast.success(t("toastSyncAllOk", { count: outcomes.length }))
      } else {
        toast.error(t("toastSyncAllPartial", { failed: failures.length, total: outcomes.length }))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      setRows(snapshot())
    }
  }, [t])

  const anyError = rows.some((r) => r.lastError !== null)

  return (
    <Card data-testid="sync-status-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {t("title")}
            {anyError ? (
              <span className="flex items-center gap-1 text-[10px] uppercase text-amber-500">
                <CircleIcon className="h-2 w-2 fill-current" />
                {t("statusErrors")}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] uppercase text-emerald-500">
                <CircleIcon className="h-2 w-2 fill-current" />
                {t("statusHealthy")}
              </span>
            )}
          </CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onSyncAll}
          disabled={busy === "all"}
          aria-label={t("syncAllAria")}
        >
          {busy === "all" ? (
            <LoaderIcon className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="mr-1 h-3.5 w-3.5" />
          )}
          {t("syncAll")}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t("colTable")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("colLastSync")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("colCursor")}</TableHead>
                <TableHead className="w-[100px] whitespace-nowrap text-right">
                  {t("colActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const rowBusy = isBusy(row.table)
                return (
                  <TableRow key={row.table} data-testid={`sync-status-row-${row.table}`}>
                    <TableCell className="font-mono text-xs">
                      {t(`tableLabels.${row.table}`)}
                      {row.lastError && (
                        <p
                          className="mt-0.5 text-[10px] text-destructive break-all"
                          data-testid={`sync-status-row-${row.table}-error`}
                        >
                          {row.lastError}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.lastSyncAt ? formatRelative(row.lastSyncAt) : t("never")}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {row.since === 0 ? "—" : `#${row.since}`}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onSyncOne(row.table)}
                        disabled={rowBusy || busy === "all"}
                        aria-label={t("syncNowAria", { table: t(`tableLabels.${row.table}`) })}
                      >
                        {rowBusy ? (
                          <LoaderIcon className={cn("h-3.5 w-3.5 animate-spin")} />
                        ) : (
                          <RefreshCwIcon className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
