"use client"

/**
 * Logs → Overview.
 *
 * The read-only half of the section: what the logging pipeline is doing right
 * now, and the two places you go to actually read logs. Previously this was a
 * status banner buried at the top of the Transports tab plus two link cards
 * stacked above the whole panel, so the one thing a user opens this section to
 * check — "is logging even working?" — was the hardest thing to find.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ExternalLinkIcon, FileTextIcon, ScrollTextIcon } from "lucide-react"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import { NativeLogViewer } from "@/components/logging/native-log-viewer"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

export interface LogsOverviewPanelProps {
  nativeLogging: NativeLoggingReadiness
  healthByTransport: Record<string, TransportHealthSnapshot>
  /** Closes the host Settings dialog before navigating to `/logs`. */
  onNavigateAway?: () => void
}

type StatusTone = "success" | "warning" | "danger" | "muted"

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "border-success/40 bg-success/5 text-success",
  warning: "border-warning/40 bg-warning/5 text-warning",
  danger: "border-destructive/50 bg-destructive/5 text-destructive",
  muted: "border-border bg-muted/40 text-muted-foreground",
}

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
}

export function toneForNativeStatus(status: NativeLoggingReadiness["status"]): StatusTone {
  switch (status) {
    case "healthy":
      return "success"
    case "degraded":
      return "warning"
    default:
      return "muted"
  }
}

export function toneForTransportStatus(status: TransportHealthSnapshot["status"]): StatusTone {
  switch (status) {
    case "healthy":
      return "success"
    case "degraded":
      return "warning"
    // `offline` covers both "no network" and "not applicable in this runtime"
    // (native/breadcrumb on web), so it reads muted rather than alarming.
    default:
      return "muted"
  }
}

/** One `label: value` cell of the readiness grid. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  )
}

export function LogsOverviewPanel({
  nativeLogging,
  healthByTransport,
  onNavigateAway,
}: LogsOverviewPanelProps) {
  const t = useTranslations("logging")
  const tLogs = useTranslations("settings.logs")

  const tone = toneForNativeStatus(nativeLogging.status)
  const problems = [
    nativeLogging.fallbackReason?.message
      ? {
          label: t("settings.native.fallbackReason"),
          message: nativeLogging.fallbackReason.message,
        }
      : null,
    nativeLogging.platformLogging.error
      ? { label: t("settings.native.platformError"), message: nativeLogging.platformLogging.error }
      : null,
    nativeLogging.bridgeLastError
      ? { label: t("settings.native.bridgeError"), message: nativeLogging.bridgeLastError }
      : null,
  ].filter((entry): entry is { label: string; message: string } => entry !== null)

  const transports = Object.values(healthByTransport).sort((left, right) =>
    left.transport.localeCompare(right.transport)
  )

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<ScrollTextIcon />}
        title={t("settings.native.title")}
        description={t("settings.overview.readinessDescription")}
        testid="logs-overview-readiness"
        badge={
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            {nativeLogging.status}
          </Badge>
        }
      >
        <div className={cn("rounded-lg border p-3", TONE_CLASSES[tone])} role="status">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 @lg/settings-stack:grid-cols-3">
            <Fact label={t("settings.native.mode")} value={nativeLogging.startupMode} />
            <Fact label={t("settings.native.bridge")} value={nativeLogging.bridgeState} />
            <Fact
              label={t("settings.native.platformBackend")}
              value={nativeLogging.platformLogging.backend}
            />
            <Fact
              label={t("settings.native.platformHealth")}
              value={nativeLogging.platformLogging.health}
            />
            <Fact
              label={t("settings.native.platformLevel")}
              value={nativeLogging.platformLogging.minLevel}
            />
            <Fact
              label={t("settings.native.targets")}
              value={
                nativeLogging.activeTargets.length > 0
                  ? nativeLogging.activeTargets.join(", ")
                  : t("panel.nativeLoggingNoTargets")
              }
            />
          </dl>
        </div>

        {problems.length > 0 ? (
          <ul className="space-y-1.5" data-testid="logs-overview-problems">
            {problems.map((problem) => (
              <li key={problem.label} className="flex items-start gap-1.5 text-xs">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span className="min-w-0">
                  <span className="font-medium">{problem.label}: </span>
                  <span className="text-muted-foreground">{problem.message}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsBlock>

      <SettingsBlock
        title={t("settings.overview.transportHealthTitle")}
        description={t("settings.overview.transportHealthDescription")}
        testid="logs-overview-transport-health"
      >
        {transports.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.overview.noTransports")}</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border">
            {transports.map((health) => {
              const transportTone = toneForTransportStatus(health.status)
              return (
                <li
                  key={health.transport}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                  data-testid={`logs-transport-health-${health.transport}`}
                >
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[transportTone])}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {health.transport}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                    {health.status}
                  </Badge>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {t("settings.overview.queueDepth", { count: health.queueDepth })}
                    {health.droppedEntries > 0
                      ? ` · ${t("settings.overview.dropped", { count: health.droppedEntries })}`
                      : ""}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsBlock>

      <SettingsBlock
        icon={<FileTextIcon />}
        title={tLogs("nativeCardTitle")}
        description={tLogs("nativeCardDescription")}
        testid="logs-overview-native-files"
        collapsible
        defaultOpen={false}
      >
        <NativeLogViewer />
      </SettingsBlock>

      <SettingsBlock
        title={tLogs("linkCardTitle")}
        description={tLogs("linkCardDescription")}
        testid="logs-overview-open-panel"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/logs" onClick={() => onNavigateAway?.()}>
              <ExternalLinkIcon className="mr-1.5 size-3.5" />
              {tLogs("openPanel")}
            </Link>
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">{tLogs("linkCardFooter")}</p>
      </SettingsBlock>
    </SettingsStack>
  )
}
