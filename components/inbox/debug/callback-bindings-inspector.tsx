"use client"

/**
 * Diagnostic drawer that lists recent A2UI callback bindings for the
 * current conversation alongside any audit rows that reported a binding
 * miss (`callback.unbound`, `callback.handler_failed`).
 *
 * Bindings live in `connectorCallbackBindings`; the renderer keys off
 * `conversationKey` so an operator triaging "the Slack button didn't
 * route my A2UI surface" can see exactly which actionIds the assistant
 * wrote, when they were created, and whether the inbound callback hit
 * the bus or got dropped.
 *
 * Three actions per row:
 *   - Copy actionId to clipboard.
 *   - Re-fire the callback as if the user pressed it (drives
 *     `dispatchConnectorCallback` so the assistant turn picks up the
 *     virtual action).
 *   - Delete the binding (releases the row for cleanup).
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CopyIcon, PlayIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getDb } from "@/lib/db/schema"
import { getBus } from "@/lib/connectors/bus"
import { cn } from "@/lib/utils"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"

const MAX_ROWS = 50

export interface CallbackBindingsInspectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationKey: string
  adapterId: string
}

export function CallbackBindingsInspector({
  open,
  onOpenChange,
  conversationKey,
  adapterId,
}: CallbackBindingsInspectorProps) {
  const t = useTranslations("inbox.bindingsInspector")
  const [busyId, setBusyId] = useState<string | null>(null)
  // Snapshot `Date.now()` into state and refresh once per minute. Reading
  // a clock during render trips `react-hooks/purity`; subscribing via an
  // effect keeps the comparison stable across re-renders.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [open])

  const bindings = useLiveQuery<ConnectorCallbackBindingRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .connectorCallbackBindings.where("conversationKey")
            .equals(conversationKey)
            .reverse()
            .sortBy("createdAt")
            .then((rows) => rows.slice(0, MAX_ROWS)),
    [conversationKey]
  )

  const failures = useLiveQuery<ConnectorAuditRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .connectorAudit.where("at")
            .above(Date.now() - 24 * 60 * 60 * 1000)
            .filter(
              (row) =>
                row.adapterId === adapterId &&
                row.conversationKey === conversationKey &&
                (row.kind === "callback.unbound" || row.kind === "callback.handler_failed")
            )
            .reverse()
            .sortBy("at"),
    [adapterId, conversationKey]
  )

  const failureCount = (failures ?? []).length

  const onCopy = async (actionId: string) => {
    try {
      await navigator.clipboard.writeText(actionId)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }

  const onTest = async (row: ConnectorCallbackBindingRow) => {
    setBusyId(row.id)
    try {
      const bus = getBus()
      await bus.dispatchConnectorCallback({
        adapterId: row.adapterId,
        actionId: row.actionId,
        surfaceId: row.surfaceId,
        componentId: row.componentId,
        conversationKey: row.conversationKey ?? conversationKey,
        kind: row.kind,
        payload: { synthetic: true, source: "inspector" },
      } as never)
      toast.success(t("testQueued"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = async (id: string) => {
    try {
      await getDb().connectorCallbackBindings.delete(id)
      toast.message(t("deleted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const rows = useMemo(() => bindings ?? [], [bindings])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-md flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle", { count: rows.length })}</SheetDescription>
        </SheetHeader>
        {failureCount > 0 && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
            data-testid="bindings-failures-banner"
          >
            <p className="font-medium text-destructive">{t("failures", { count: failureCount })}</p>
            <ul className="mt-1 space-y-0.5">
              {(failures ?? []).slice(0, 5).map((row) => (
                <li key={row.id} className="font-mono text-[11px] text-destructive/80">
                  {row.kind}
                  {row.reason ? ` — ${row.reason}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ScrollArea className="flex-1" data-testid="bindings-scroll">
          <ul className="space-y-2 pr-2">
            {rows.length === 0 ? (
              <li className="rounded border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                {t("empty")}
              </li>
            ) : (
              rows.map((row) => (
                <li
                  key={row.id}
                  className="rounded-md border bg-muted/20 px-3 py-2"
                  data-testid={`binding-row-${row.actionId}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs">{row.actionId}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          {row.kind}
                        </Badge>
                        {row.componentId && (
                          <Badge variant="secondary" className="text-[10px]">
                            {row.componentId}
                          </Badge>
                        )}
                        <span
                          className={cn(
                            "text-[10px]",
                            row.expiresAt && row.expiresAt < now
                              ? "text-destructive"
                              : "text-muted-foreground"
                          )}
                        >
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => void onCopy(row.actionId)}
                        aria-label={t("copyAria", { id: row.actionId })}
                        data-testid={`binding-copy-${row.actionId}`}
                      >
                        <CopyIcon className="h-3 w-3" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => void onTest(row)}
                        disabled={busyId === row.id}
                        aria-label={t("testAria", { id: row.actionId })}
                        data-testid={`binding-test-${row.actionId}`}
                      >
                        <PlayIcon className="h-3 w-3" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive"
                        onClick={() => void onDelete(row.id)}
                        aria-label={t("deleteAria", { id: row.actionId })}
                        data-testid={`binding-delete-${row.actionId}`}
                      >
                        <Trash2Icon className="h-3 w-3" aria-hidden />
                      </Button>
                    </div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
