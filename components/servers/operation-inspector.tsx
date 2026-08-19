"use client"

/**
 * Full detail for one queued or finished operation.
 *
 * The old panel rendered an operation as a kind and a state badge, which is
 * enough to see that something failed and never enough to see why — the
 * controller's `error.code`/`error.message` and the agent's `result` were both
 * fetched and then dropped on the floor. This is where they land.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BanIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { Operation, OperationEvent } from "@/lib/server-ops/client"
import { cn } from "@/lib/utils"
import { isRunningOperationState, OperationStateBadge, useAbsoluteTime } from "./server-visuals"

/** Only a still-queued operation can be cancelled — see `cancelOperation`. */
export function isCancellableOperation(operation: Operation): boolean {
  return operation.state === "queued"
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const t = useTranslations("servers")
  const text = stableJson(value)
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success(t("operations.copied")))
              .catch(() => toast.error(t("operations.copyFailed")))
          }}
        >
          <CopyIcon className="size-3" aria-hidden="true" />
          {t("operations.copy")}
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </section>
  )
}

/**
 * The operation's state-change trail.
 *
 * Loaded from the controller rather than accumulated from the live stream: an
 * operation opened from history — queued before this tab existed, or by another
 * operator — has no stream events to accumulate, and "no timeline" would read
 * as "nothing happened" rather than "this client wasn't listening".
 */
function OperationTimeline({
  operation,
  loadEvents,
}: {
  operation: Operation
  loadEvents: ((operationId: string) => Promise<OperationEvent[]>) | null
}) {
  const t = useTranslations("servers")
  const absolute = useAbsoluteTime()
  const [state, setState] = useState<{
    operationId: string
    events: readonly OperationEvent[]
  } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!loadEvents) return
    let cancelled = false
    void (async () => {
      try {
        const events = await loadEvents(operation.id)
        if (!cancelled) setState({ operationId: operation.id, events })
      } catch {
        // A missing trail is not worth a toast — the operation itself is on
        // screen, and this section says so inline.
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // `operation.updatedAt` re-reads the trail as the live stream advances the
    // operation, so an open inspector fills in rather than freezing.
  }, [loadEvents, operation.id, operation.updatedAt])

  const events = state?.operationId === operation.id ? state.events : []

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{t("operations.timeline")}</h3>
      {events.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {failed ? t("operations.timelineFailed") : t("operations.timelineEmpty")}
        </p>
      ) : (
        <ol className="space-y-0">
          {events.map((event, index) => (
            <li key={event.id} className="flex gap-3">
              <span className="flex flex-col items-center" aria-hidden="true">
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    isRunningOperationState(event.state) ? "bg-primary" : "bg-muted-foreground/40"
                  )}
                />
                {index < events.length - 1 && <span className="w-px flex-1 bg-border" />}
              </span>
              <span className="min-w-0 flex-1 pb-4">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t(`operationStates.${event.state}`)}</span>
                  <span className="text-xs text-muted-foreground">{absolute(event.timestamp)}</span>
                </span>
                {event.message && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {event.message}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function OperationInspector({
  operation,
  onOpenChange,
  onCancel,
  loadEvents,
}: {
  operation: Operation | null
  onOpenChange: (open: boolean) => void
  onCancel: (operationId: string) => void
  /** Null while disconnected; the timeline then explains itself instead. */
  loadEvents?: ((operationId: string) => Promise<OperationEvent[]>) | null
}) {
  const t = useTranslations("servers")
  const absolute = useAbsoluteTime()
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  return (
    <>
      <Sheet open={operation !== null} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
          {operation && (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="flex flex-wrap items-center gap-2">
                  {t(`operationKinds.${operation.kind}` as "operationKinds.deploy")}
                  <OperationStateBadge state={operation.state} />
                </SheetTitle>
                <SheetDescription className="font-mono text-xs break-all">
                  {operation.id}
                </SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-5 p-4">
                  {operation.error && (
                    <Alert variant="destructive">
                      <AlertTitle className="font-mono text-xs">{operation.error.code}</AlertTitle>
                      <AlertDescription>{operation.error.message}</AlertDescription>
                    </Alert>
                  )}

                  <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
                    {(
                      [
                        [t("operations.target"), operation.targetId],
                        [t("operations.createdBy"), operation.createdBy],
                        [t("operations.createdAt"), absolute(operation.createdAt)],
                        [t("operations.updatedAt"), absolute(operation.updatedAt)],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="bg-background p-3">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-1 text-sm font-medium break-all">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  <OperationTimeline operation={operation} loadEvents={loadEvents ?? null} />

                  <PayloadBlock label={t("operations.request")} value={operation.request} />
                  {operation.result !== null && operation.result !== undefined && (
                    <PayloadBlock label={t("operations.result")} value={operation.result} />
                  )}
                  {operation.error?.details !== undefined && (
                    <PayloadBlock
                      label={t("operations.errorDetails")}
                      value={operation.error.details}
                    />
                  )}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between gap-2 border-t p-4">
                <p className="text-xs text-muted-foreground">
                  {isCancellableOperation(operation)
                    ? t("operations.cancelHint")
                    : t("operations.cancelUnavailable")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!isCancellableOperation(operation)}
                  onClick={() => setConfirmingCancel(true)}
                >
                  <BanIcon className="size-4" aria-hidden="true" />
                  {t("operations.cancel")}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("operations.cancelConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("operations.cancelConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (operation) onCancel(operation.id)
                setConfirmingCancel(false)
              }}
            >
              {t("operations.cancel")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
