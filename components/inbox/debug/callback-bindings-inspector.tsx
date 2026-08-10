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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
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
      <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle", { count: rows.length })}</SheetDescription>
        </SheetHeader>
        {failureCount > 0 && (
          <Alert
            variant="destructive"
            className="rounded-none border-x-0 bg-transparent"
            data-testid="bindings-failures-banner"
          >
            <AlertTitle>{t("failures", { count: failureCount })}</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 flex flex-col gap-0.5">
                {(failures ?? []).slice(0, 5).map((row) => (
                  <li key={row.id} className="font-mono text-[11px] text-destructive/80">
                    {row.kind}
                    {row.reason ? ` — ${row.reason}` : ""}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <ScrollArea className="flex-1" data-testid="bindings-scroll">
          <ItemGroup role={rows.length === 0 ? undefined : "list"} className="divide-y pr-2">
            {rows.length === 0 ? (
              <Empty className="rounded-none border-0 px-3 py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CopyIcon aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>{t("title")}</EmptyTitle>
                  <EmptyDescription>{t("empty")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              rows.map((row) => (
                <Item
                  key={row.id}
                  role="listitem"
                  size="sm"
                  className="rounded-none px-0"
                  data-testid={`binding-row-${row.actionId}`}
                >
                  <ItemContent>
                    <ItemTitle className="max-w-full truncate font-mono text-xs">
                      {row.actionId}
                    </ItemTitle>
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
                  </ItemContent>
                  <ItemActions className="gap-1">
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
                  </ItemActions>
                </Item>
              ))
            )}
          </ItemGroup>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
