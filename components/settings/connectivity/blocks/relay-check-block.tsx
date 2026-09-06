"use client"

/**
 * Cloud & relay → ask the rendezvous what it is.
 *
 * The WebRTC card below holds the switch and the URL. This block is the
 * proof: one button that fetches the relay's `/healthz` and says, in a
 * sentence, whether a device on another network will get through, and
 * whether the relay predates the application data lane (ADR-0170). The
 * banner above reads the same result.
 */

import { useTranslations } from "next-intl"
import { CircleIcon, RadarIcon, RefreshCwIcon } from "lucide-react"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { RelaySlice } from "@/hooks/connectivity/use-remote-access"
import { relayProtocolMatches } from "@/lib/signaling/relay-probe"
import { SIGNALING_PROTOCOL_VERSION } from "@/lib/signaling/types"
import { cn } from "@/lib/utils"

export interface RelayCheckBlockProps {
  relay: RelaySlice
  /** Test seam for the "checked at" clock. */
  formatTime?: (ms: number) => string
}

const defaultFormatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

export function RelayCheckBlock({ relay, formatTime = defaultFormatTime }: RelayCheckBlockProps) {
  const t = useTranslations("settings.connectivity.relayCheck")
  const { result, enabled, checking, source } = relay

  const tone =
    !enabled || !result
      ? "text-muted-foreground"
      : result.state === "ready" && relayProtocolMatches(result.capabilities)
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-amber-600 dark:text-amber-400"

  let message: string | null = null
  if (!enabled) {
    message = t("off")
  } else if (result) {
    const ms = result.latencyMs ?? 0
    switch (result.state) {
      case "ready":
        message = relayProtocolMatches(result.capabilities)
          ? t("ready", {
              ms,
              protocol: result.capabilities?.protocol ?? 0,
              backend: result.backend ?? "?",
              version: result.version ?? "?",
            })
          : t("legacyProtocol", {
              ms,
              theirs: result.capabilities?.protocol ?? 0,
              ours: SIGNALING_PROTOCOL_VERSION,
            })
        break
      case "legacy":
        message = t("legacy", { ms })
        break
      case "unreachable":
        message = t("unreachable", { url: result.healthUrl ?? "", error: result.error ?? "" })
        break
      case "not-a-relay":
        message = t("notRelay", { url: result.healthUrl ?? "", error: result.error ?? "" })
        break
      case "cors-blocked":
        message = t("corsBlocked", { url: result.healthUrl ?? "" })
        break
      case "invalid-url":
        message = t("invalidUrl")
        break
    }
  }

  return (
    <SettingsBlock
      icon={<RadarIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        result && enabled ? (
          <Badge
            variant="outline"
            className={cn("gap-1.5", tone)}
            data-testid="relay-check-state"
            data-state={result.state}
          >
            <CircleIcon className="size-2 fill-current" aria-hidden="true" />
            {result.state}
          </Badge>
        ) : null
      }
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void relay.check()}
          disabled={checking || !enabled || source === "unavailable"}
          data-testid="relay-check-button"
        >
          <RefreshCwIcon
            className={cn("mr-1 size-3.5", checking && "animate-spin")}
            aria-hidden="true"
          />
          {checking ? t("checking") : t("check")}
        </Button>
      }
      testid="relay-check-block"
      settingId="connectivity-relay-check"
      attributes={{ "data-source": source }}
    >
      <p
        className="break-all font-mono text-xs text-muted-foreground"
        data-testid="relay-check-url"
      >
        {relay.signalingUrl}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {source === "local" ? t("sourceLocal") : source === "host" ? t("sourceHost") : null}
      </p>
      {message ? (
        <p role="status" className={cn("text-xs", tone)} data-testid="relay-check-message">
          {message}
        </p>
      ) : null}
      {result?.capabilities?.lanes.length ? (
        <p className="text-[11px] text-muted-foreground" data-testid="relay-check-lanes">
          {t("lanes", { lanes: result.capabilities.lanes.join(", ") })}
          {relay.checkedAt ? ` · ${t("lastChecked", { time: formatTime(relay.checkedAt) })}` : ""}
        </p>
      ) : relay.checkedAt ? (
        <p className="text-[11px] text-muted-foreground">
          {t("lastChecked", { time: formatTime(relay.checkedAt) })}
        </p>
      ) : null}
    </SettingsBlock>
  )
}
