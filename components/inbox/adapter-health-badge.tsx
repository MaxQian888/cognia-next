"use client"

/**
 * Compact health badge for the Inbox conversation header.
 *
 * Renders ONLY when the adapter behind the current conversation is in a
 * non-nominal state — Linear-style "quiet when healthy, loud when not".
 * The badge is a click target; clicking opens a popover with:
 *
 *   • The specific state (breaker open / rate exhausted / degraded /
 *     down) with the operator-facing reason.
 *   • An ETA when the runtime can compute one (rate bucket refill time,
 *     breaker cooldown remainder).
 *   • A "Reconnect" affordance (Tauri-only; mirrors the per-row reconnect
 *     in `ConnectionLossBanner`) that re-queues the adapter lifecycle.
 *   • A "Open full health" link to Settings → Connections → Adapter
 *     health for the deep view.
 *
 * Backend data: `useAdapterHealth(adapterId)` already surfaces
 * `current.state`, `breaker`, `rateBucket`, `lastError`. No new selector
 * required — the badge is a thin presentation layer on the existing hook.
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArrowRightIcon, LoaderIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { requeueAdapter } from "@/lib/connectors/lifecycle"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { decideBadge, STATE_ICON, STATE_TINT, type BadgeState } from "./adapter-health-decision"

export interface AdapterHealthBadgeProps {
  adapterId: string
}

export function AdapterHealthBadge({ adapterId }: AdapterHealthBadgeProps) {
  const t = useTranslations("inbox.conversationHeader.healthBadge")
  const health = useAdapterHealth(adapterId)
  const decision = decideBadge(health)
  const [open, setOpen] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)

  if (!decision) return null

  const Icon = STATE_ICON[decision.state]
  const label = t(stateToKey(decision.state))

  const onReconnect = async () => {
    if (!isTauri()) {
      toast.error(t("reconnectDesktopOnly"))
      return
    }
    setReconnecting(true)
    try {
      const ok = await requeueAdapter(adapterId)
      toast[ok ? "success" : "error"](ok ? t("reconnectQueued") : t("reconnectUnavailable"))
      if (ok) setOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t("aria", { state: label })}
          data-testid="adapter-health-badge"
          className={cn("h-7 gap-1 px-2 text-xs", STATE_TINT[decision.state])}
        >
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 space-y-2 text-xs"
        data-testid="adapter-health-popover"
      >
        <div className="space-y-1">
          <p className="font-medium">{label}</p>
          {decision.reason && (
            <p className="text-muted-foreground" data-testid="adapter-health-reason">
              {decision.reason}
            </p>
          )}
          {decision.etaMs && (
            <p className="text-muted-foreground" data-testid="adapter-health-eta">
              {t("eta", { date: new Date(decision.etaMs).toLocaleTimeString() })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-7 px-2 text-xs"
            disabled={reconnecting}
            onClick={() => void onReconnect()}
            data-testid="adapter-health-reconnect"
          >
            {reconnecting ? (
              <LoaderIcon className="mr-1 h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <RefreshCwIcon className="mr-1 h-3 w-3" aria-hidden />
            )}
            {t("reconnect")}
          </Button>
          <Button
            asChild
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            data-testid="adapter-health-open-full"
          >
            <Link href={`/settings/connections?adapterId=${encodeURIComponent(adapterId)}`}>
              {t("openHealth")}
              <ArrowRightIcon className="ml-1 h-3 w-3" aria-hidden />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Sub-component used by tests to verify the decision predicate without
 * mounting the React tree. Exported for testability only — production
 * callers should mount `<AdapterHealthBadge />` and let it consume the
 * live hook.
 */
export const __TESTING__ = { decideBadge }

function stateToKey(state: BadgeState): "breakerOpen" | "rateLimited" | "degraded" | "down" {
  switch (state) {
    case "breaker-open":
      return "breakerOpen"
    case "rate-limited":
      return "rateLimited"
    case "degraded":
      return "degraded"
    case "down":
      return "down"
  }
}
