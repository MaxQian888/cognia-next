"use client"

/**
 * Surfaces adapters in `degraded` or `down` state so operators don't have to
 * open Settings to notice a transport failure.
 *
 * Presentation only — `useDegradedAdapters` owns the heartbeat query and the
 * per-set dismiss bookkeeping, and `InboxNoticeArea` decides whether to mount
 * this at all.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LoaderIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { requeueAdapter } from "@/lib/connectors/lifecycle"
import { isTauri } from "@/lib/tauri"
import type { DegradedAdapter } from "@/hooks/connectors/use-degraded-adapters"
import { NoticeItem } from "./notices/notice-item"

export interface ConnectionLossNoticeProps {
  adapters: DegradedAdapter[]
  onDismiss: () => void
}

export function ConnectionLossNotice({ adapters, onDismiss }: ConnectionLossNoticeProps) {
  const t = useTranslations("inbox.connectionLoss")
  const [reconnecting, setReconnecting] = useState<Set<string>>(() => new Set())

  if (adapters.length === 0) return null

  const onReconnectOne = async (adapterId: string) => {
    if (!isTauri()) {
      toast.error(t("reconnectDesktopOnly"))
      return
    }
    setReconnecting((prev) => new Set(prev).add(adapterId))
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

  const onReconnectAll = () => {
    // Best-effort — kick each in parallel but track them individually.
    for (const adapter of adapters) void onReconnectOne(adapter.adapterId)
  }

  return (
    <NoticeItem
      severity="warning"
      data-testid="connection-loss-banner"
      title={
        <span data-testid="connection-loss-banner-headline">
          {t("headline", { count: adapters.length })}
        </span>
      }
      onDismiss={onDismiss}
      dismissLabel={t("dismiss")}
      dismissTestId="connection-loss-dismiss"
      actions={
        adapters.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={onReconnectAll}
            disabled={!isTauri()}
            data-testid="connection-loss-reconnect-all"
          >
            {t("reconnectAll")}
          </Button>
        ) : null
      }
    >
      <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {adapters.map((adapter) => (
          <li
            key={adapter.adapterId}
            className="flex items-center gap-1.5"
            data-testid={`connection-loss-row-${adapter.adapterId}`}
          >
            <span className="font-mono text-[11px]">{adapter.adapterId}</span>
            <span className="text-muted-foreground">{t(`state.${adapter.state}`)}</span>
            {adapter.reason && <span className="text-muted-foreground/80">— {adapter.reason}</span>}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-5 px-1 text-[11px]"
              disabled={reconnecting.has(adapter.adapterId) || !isTauri()}
              onClick={() => void onReconnectOne(adapter.adapterId)}
              data-testid={`connection-loss-reconnect-${adapter.adapterId}`}
            >
              {reconnecting.has(adapter.adapterId) ? (
                <LoaderIcon className="mr-1 size-3 animate-spin" aria-hidden />
              ) : (
                <RefreshCwIcon className="mr-1 size-3" aria-hidden />
              )}
              {t("reconnect")}
            </Button>
          </li>
        ))}
      </ul>
    </NoticeItem>
  )
}
