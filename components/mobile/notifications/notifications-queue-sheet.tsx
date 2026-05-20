"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { EmptyState } from "@/components/mobile/empty-state"
import {
  cancel as cancelNotifications,
  listPending,
  type LocalNotificationSpec,
} from "@/lib/capacitor/local-notifications"
import { cn } from "@/lib/utils"

/**
 * Bottom sheet listing every scheduled local notification (Wave 4.x).
 * Backs the "Notifications" row on the mobile settings panel — gives
 * users an at-a-glance view of what cognia has queued (backup reminders,
 * scheduler nudges) plus a per-row cancel.
 *
 * The wrapper [`listPending`] returns `unsupported` on web/Tauri; in
 * that case the sheet renders an empty state with a brief explanation
 * instead of pretending the platform supports it.
 */

export interface NotificationsQueueSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Test seam. */
  lister?: typeof listPending
  /** Test seam. */
  canceller?: typeof cancelNotifications
}

type Phase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "loaded"; items: LocalNotificationSpec[] }
  | { kind: "error"; message: string }

export function NotificationsQueueSheet({
  open,
  onOpenChange,
  lister = listPending,
  canceller = cancelNotifications,
}: NotificationsQueueSheetProps) {
  const t = useTranslations("mobile.notifications.queue")
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [cancelling, setCancelling] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setPhase({ kind: "loading" })
    const out = await lister()
    if (out.kind === "unsupported") {
      setPhase({ kind: "unsupported" })
      return
    }
    if (out.kind === "error") {
      setPhase({ kind: "error", message: out.message })
      return
    }
    setPhase({ kind: "loaded", items: out.value })
  }, [lister])

  // On open, fetch the queue inline so the very first instruction inside
  // the effect body is the async function call (no sync setState). The
  // initial `useState({ kind: "loading" })` already shows the spinner
  // until this promise resolves.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const out = await lister()
      if (cancelled) return
      if (out.kind === "unsupported") {
        setPhase({ kind: "unsupported" })
        return
      }
      if (out.kind === "error") {
        setPhase({ kind: "error", message: out.message })
        return
      }
      setPhase({ kind: "loaded", items: out.value })
    })()
    return () => {
      cancelled = true
    }
  }, [open, lister])

  const onCancel = useCallback(
    async (id: number) => {
      setCancelling(id)
      try {
        const out = await canceller([id])
        if (out.kind === "ok") {
          // Optimistic local removal while we refresh from the source.
          setPhase((p) => {
            if (p.kind !== "loaded") return p
            return { kind: "loaded", items: p.items.filter((n) => n.id !== id) }
          })
          await refresh()
        } else if (out.kind === "error") {
          toast.error(t("cancelFailed", { message: out.message }))
        }
      } finally {
        setCancelling(null)
      }
    },
    [canceller, refresh, t]
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[70dvh] gap-0 p-0"
        data-testid="notifications-queue-sheet"
      >
        <SheetHeader className="flex flex-row items-center justify-between gap-2 px-4 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <BellIcon className="size-4" aria-hidden="true" />
            {t("title")}
          </SheetTitle>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5"
            onClick={() => void refresh()}
            disabled={phase.kind === "loading"}
            data-testid="notifications-queue-refresh"
          >
            <RefreshCwIcon
              className={cn("size-3.5", phase.kind === "loading" && "animate-spin")}
              aria-hidden="true"
            />
            {t("refresh")}
          </Button>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {phase.kind === "unsupported" ? (
            <EmptyState
              icon={BellIcon}
              title={t("unsupportedTitle")}
              description={t("unsupportedDescription")}
            />
          ) : phase.kind === "error" ? (
            <EmptyState icon={BellIcon} title={t("errorTitle")} description={phase.message} />
          ) : phase.kind === "loaded" && phase.items.length === 0 ? (
            <EmptyState icon={BellIcon} title={t("empty")} />
          ) : phase.kind === "loaded" ? (
            <ul className="flex flex-col gap-2" data-testid="notifications-queue-list">
              {phase.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded border bg-card px-3 py-2"
                  data-testid={`notifications-queue-row-${item.id}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{item.body}</span>
                    {item.schedule?.at ? (
                      <span className="text-[10px] text-muted-foreground">
                        {t("scheduledAt", {
                          time: new Date(item.schedule.at).toLocaleString(),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-[10px]"
                    onClick={() => void onCancel(item.id)}
                    disabled={cancelling === item.id}
                    data-testid={`notifications-queue-cancel-${item.id}`}
                  >
                    <Trash2Icon className="size-3" aria-hidden="true" />
                    {t("cancel")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
              {t("loading")}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
