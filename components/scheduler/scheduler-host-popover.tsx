"use client"

/**
 * Whose schedule this page manages, and which host may fire it (ADR-0179 §5).
 *
 * Folds `SchedulerHostBar` and `SchedulerAuthorityControl` into one Popover
 * behind the header's host summary. The summary is a sentence the header can
 * hold ("This device", "cloud host X"); the switch, the authority host, the
 * grace period and the explanatory copy wait behind a click, because they
 * are rarely needed and were eating a full row of the pane on every visit.
 *
 * The summary hook is exported on its own so the phone page, which has no
 * feature header, can render the same sentence above its list.
 */

import { useCallback, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  CloudIcon,
  GavelIcon,
  MonitorSmartphoneIcon,
  PauseCircleIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { useHostProfile } from "@/hooks/use-host-profile"
import { authorityHostLiveness } from "@/lib/placement/authority-host"
import {
  getExecutionAuthorityConfigServerSnapshot,
  getExecutionAuthorityConfigSnapshot,
  resolveExecutionAuthority,
  subscribeExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
  type ExecutionAuthorityConfig,
} from "@/lib/placement/authority"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { cn } from "@/lib/utils"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

/** The grace windows the ADR calls for: short enough to notice, long enough to sleep through. */
export const AUTHORITY_GRACE_OPTIONS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

const SELF_VALUE = "__self__"

export interface SchedulerHostSummary {
  /** `local` or `paired`, the schedule being read and written. */
  target: "local" | "paired"
  /** The sentence for the header: "This device" or the paired host's name. */
  label: string
  /** A paired host exists, so the switch is offered. */
  pairedAvailable: boolean
  /** The local schedule is stood down because this desktop drives a remote host. */
  suspended: boolean
  /** The local schedule only ticks while the app is open (a companion). */
  onlyWhileOpen: boolean
  /** The label of the other side, for the switch button. */
  pairedLabel: string
  setTarget: (target: "local" | "paired") => void
}

export function useSchedulerHostSummary(): SchedulerHostSummary {
  const t = useTranslations("scheduler.hostBar")
  const { target, pairedAvailable, setTarget } = useSchedulerHostTarget()
  const profile = useHostProfile()
  const activeRemoteLabel = useRemoteHostStore((s) => {
    const host = s.hosts.find((h) => h.id === s.activeHostId)
    return host?.label ?? host?.config.baseUrl ?? null
  })
  const desktopDrivingRemote = profile === "desktop" && isRemoteHostActive()
  const pairedLabel =
    desktopDrivingRemote && activeRemoteLabel
      ? t("pairedNamed", { name: activeRemoteLabel })
      : profile === "mobile-companion"
        ? t("pairedDesktop")
        : t("pairedCloud")
  return {
    target,
    label: target === "paired" ? pairedLabel : t("thisDevice"),
    pairedAvailable,
    suspended: target === "local" && desktopDrivingRemote,
    onlyWhileOpen: target === "local" && !desktopDrivingRemote && pairedAvailable,
    pairedLabel,
    setTarget,
  }
}

async function reconcileScheduler(): Promise<void> {
  try {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    await getTaskScheduler().reconcileTimingAuthority()
  } catch {
    // The config is persisted either way; the next arm consults it. A scheduler
    // that is not running on this host has nothing to reconcile.
  }
}

export interface SchedulerHostPopoverProps {
  className?: string
  /** Injected in tests so a case can drive a fixed clock. */
  now?: () => number
  /** Injected in tests; production re-arms the live scheduler. */
  onConfigChange?: (config: ExecutionAuthorityConfig) => void | Promise<void>
}

/** The header's host status badge: suspended, only-while-open, or nothing. */
export function SchedulerHostStatusBadge({ summary }: { summary: SchedulerHostSummary }) {
  const t = useTranslations("scheduler.hostBar")
  if (summary.suspended) {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 text-[10px]"
        data-testid="scheduler-host-suspended"
      >
        <PauseCircleIcon className="size-3" aria-hidden="true" />
        {t("localSuspended")}
      </Badge>
    )
  }
  if (summary.onlyWhileOpen) {
    return (
      <Badge
        variant="outline"
        className="h-5 text-[10px] font-normal"
        data-testid="scheduler-host-only-open"
      >
        {t("localOnlyWhileOpen")}
      </Badge>
    )
  }
  return null
}

/** The header's host summary: icon + the host being managed. */
export function SchedulerHostSummaryLine({
  summary,
  className,
}: {
  summary: SchedulerHostSummary
  className?: string
}) {
  const t = useTranslations("scheduler.hostBar")
  const Icon = summary.target === "paired" ? CloudIcon : MonitorSmartphoneIcon
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      data-testid="scheduler-host-summary"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("managing", { host: summary.label })}</span>
    </span>
  )
}

export function SchedulerHostPopover({
  className,
  now,
  onConfigChange,
}: SchedulerHostPopoverProps) {
  const t = useTranslations("scheduler.hostBar")
  const tAuthority = useTranslations("scheduler.authority")
  const tPopover = useTranslations("scheduler.hostPopover")
  const summary = useSchedulerHostSummary()
  const hosts = useRemoteHostStore((state) => state.hosts)
  // The config lives in localStorage, which is unreadable during the
  // static-export render pass: `useSyncExternalStore` keeps the prerendered
  // default and the post-hydration stored value in agreement.
  const config = useSyncExternalStore(
    subscribeExecutionAuthorityConfig,
    getExecutionAuthorityConfigSnapshot,
    getExecutionAuthorityConfigServerSnapshot
  )

  const apply = useCallback(
    (next: ExecutionAuthorityConfig) => {
      writeExecutionAuthorityConfig(next)
      void (onConfigChange ? onConfigChange(next) : reconcileScheduler())
    },
    [onConfigChange]
  )

  const clock = now ?? Date.now
  const selected = config.hostId ? hosts.find((host) => host.id === config.hostId) : undefined
  // A configured host that has since been removed is still the configured
  // authority; snapping back to "this device" would hide a schedule the user
  // believes is owned elsewhere.
  const authorityLabel = selected?.label ?? config.hostId ?? ""
  const decision = config.hostId
    ? resolveExecutionAuthority({
        config,
        authorityLiveness: authorityHostLiveness(config.hostId),
        now: clock(),
      })
    : null

  const authorityStatus = ((): { text: string; tone: "muted" | "warning" } | null => {
    if (!decision) return null
    if (decision.degraded) {
      return {
        text:
          decision.unreachableForMs === undefined
            ? tAuthority("statusUnknown", { host: authorityLabel })
            : tAuthority("statusTakenOver", {
                host: authorityLabel,
                minutes: Math.round(decision.unreachableForMs / 60_000),
              }),
        tone: "warning",
      }
    }
    if (!decision.isAuthority && decision.unreachableForMs !== undefined) {
      return {
        text: tAuthority("statusWaiting", {
          host: authorityLabel,
          minutes: Math.max(
            0,
            Math.round((config.degradeAfterMs - decision.unreachableForMs) / 60_000)
          ),
        }),
        tone: "warning",
      }
    }
    return { text: tAuthority("statusStoodDown", { host: authorityLabel }), tone: "muted" }
  })()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-7 gap-1.5 px-2 text-xs", className)}
          data-testid="scheduler-host-popover-trigger"
        >
          <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
          {tPopover("trigger")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 space-y-4 text-xs"
        data-testid="scheduler-host-popover"
      >
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {tPopover("readsTitle")}
          </h3>
          <SchedulerHostSummaryLine summary={summary} className="font-medium" />
          <SchedulerHostStatusBadge summary={summary} />
          <p className="text-muted-foreground">
            {summary.target === "paired"
              ? t("localKindsStay")
              : summary.pairedAvailable
                ? t("localOnlyWhileOpen")
                : t("noPairedHost")}
          </p>
          {summary.pairedAvailable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => summary.setTarget(summary.target === "paired" ? "local" : "paired")}
              data-testid="scheduler-host-switch"
            >
              {summary.target === "paired"
                ? t("switchToLocal")
                : t("switchToPaired", { host: summary.pairedLabel })}
            </Button>
          ) : null}
        </section>

        {hosts.length > 0 ? (
          <section className="space-y-2 border-t pt-3" data-testid="scheduler-authority-control">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <GavelIcon className="size-3" aria-hidden="true" />
              {tPopover("firesTitle")}
            </h3>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
              <Label htmlFor="scheduler-authority-host" className="text-xs font-medium">
                {tAuthority("label")}
              </Label>
              <Select
                value={config.hostId ?? SELF_VALUE}
                onValueChange={(value) =>
                  apply({ ...config, hostId: value === SELF_VALUE ? null : value })
                }
              >
                <SelectTrigger
                  id="scheduler-authority-host"
                  size="sm"
                  className="h-7 w-full text-xs"
                  aria-label={tAuthority("label")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELF_VALUE}>{tAuthority("thisHost")}</SelectItem>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={host.id}>
                      {host.label || host.config.baseUrl}
                    </SelectItem>
                  ))}
                  {selected === undefined && config.hostId ? (
                    <SelectItem value={config.hostId}>
                      {tAuthority("unknownHost", { host: config.hostId })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>

              <Label htmlFor="scheduler-authority-grace" className="text-xs font-medium">
                {tAuthority("graceLabel")}
              </Label>
              <Select
                value={String(config.degradeAfterMs)}
                disabled={config.hostId === null}
                onValueChange={(value) => apply({ ...config, degradeAfterMs: Number(value) })}
              >
                <SelectTrigger
                  id="scheduler-authority-grace"
                  size="sm"
                  className="h-7 w-full text-xs"
                  aria-label={tAuthority("graceLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTHORITY_GRACE_OPTIONS_MS.map((ms) => (
                    <SelectItem key={ms} value={String(ms)}>
                      {tAuthority("graceMinutes", { minutes: ms / 60_000 })}
                    </SelectItem>
                  ))}
                  {AUTHORITY_GRACE_OPTIONS_MS.every((ms) => ms !== config.degradeAfterMs) ? (
                    // A config written before these options existed must stay
                    // visible rather than being silently rewritten.
                    <SelectItem value={String(config.degradeAfterMs)}>
                      {tAuthority("graceMinutes", {
                        minutes: Math.round(config.degradeAfterMs / 60_000),
                      })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            {authorityStatus ? (
              <p
                className={
                  authorityStatus.tone === "warning"
                    ? "text-amber-600 dark:text-amber-500"
                    : "text-muted-foreground"
                }
                data-testid="scheduler-authority-status"
                data-tone={authorityStatus.tone}
              >
                {authorityStatus.text}
              </p>
            ) : null}
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
