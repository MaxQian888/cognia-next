"use client"

/**
 * Read-only row showing how the mobile client is currently reaching the
 * desktop. Subscribes to `CompanionTransport.onTierChange` so the value
 * stays live without polling. Hidden outside Capacitor — the web stub
 * doesn't have a meaningful tier. (ADR-0021 follow-up.)
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isCapacitor, transport } from "@/lib/tauri"
import { transportTierTone } from "@/lib/companion/transport-tier-visuals"
import type { TransportTier } from "@/lib/tauri/transport-companion"


const TIER_KEY: Record<TransportTier, string> = {
  "rtc-direct": "rtcDirect",
  "rtc-relay": "rtcRelay",
  "ws-lan": "wsLan",
  "ws-tunnel": "wsTunnel",
  offline: "offline",
}

export function TransportTierIndicator(): React.JSX.Element | null {
  const t = useTranslations("mobile.settingsPanel")
  const tt = useTranslations("mobile.transportTier")
  const [tier, setTier] = useState<TransportTier>("offline")
  const [active, setActive] = useState<boolean>(false)
  const [reconnecting, setReconnecting] = useState(false)

  useEffect(() => {
    if (!isCapacitor()) return
    const candidate = transport as unknown as {
      getActiveTier?: () => TransportTier
      onTierChange?: (h: (t: TransportTier) => void) => () => void
    }
    if (
      typeof candidate.getActiveTier !== "function" ||
      typeof candidate.onTierChange !== "function"
    ) {
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(true)
    setTier(candidate.getActiveTier())
    return candidate.onTierChange((next) => setTier(next))
  }, [])

  const onReconnect = useCallback(() => {
    const candidate = transport as unknown as {
      reconnectRtc?: () => "ok" | "no-tier" | "throttled"
    }
    if (typeof candidate.reconnectRtc !== "function") return
    setReconnecting(true)
    try {
      const result = candidate.reconnectRtc()
      if (result === "ok") {
        toast.success(t("reconnectSuccess"))
      } else if (result === "throttled") {
        toast.warning(t("reconnectThrottled"))
      } else {
        toast.warning(t("reconnectInactive"))
      }
    } catch (err) {
      toast.error(
        t("reconnectFailed", {
          reason: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      setTimeout(() => setReconnecting(false), 800)
    }
  }, [t])

  if (!active) return null

  const key = TIER_KEY[tier]
  const canReconnect = tier === "rtc-direct" || tier === "rtc-relay"

  return (
    <section
      className="flex flex-col gap-1 rounded border bg-card px-3 py-2 text-xs"
      data-testid="mobile-transport-tier"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("transportTier")}</span>
        <span className="flex items-center gap-1.5">
          <CircleIcon aria-hidden="true" className={cn("size-2 shrink-0", transportTierTone(tier).dot)} />
          <span className="text-xs">{tt(key)}</span>
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{tt(`${key}Description`)}</p>
      {canReconnect ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-end h-7 px-2 text-[11px]"
          disabled={reconnecting}
          onClick={onReconnect}
          data-testid="mobile-transport-tier-reconnect"
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={cn("size-3 mr-1", reconnecting && "animate-spin")}
          />
          {t("reconnectButton")}
        </Button>
      ) : null}
    </section>
  )
}
