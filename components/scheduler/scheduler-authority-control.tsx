"use client"

/**
 * Which host owns scheduled-task timing (ADR-0136 decision 3).
 *
 * `resolveExecutionAuthority` has resolved this since the placement work
 * landed, but nothing could ever *configure* it: the stored config was only
 * ever the default, so every host answered "self" and two desktops signed into
 * one account each armed the same cron. This is that missing control, and it
 * lives in the Scheduled Tasks host area because that is where the user
 * already reasons about whose schedule they are looking at.
 *
 * Deliberately a machine-local preference, not synced state: there is no
 * election, no lease negotiation, and no host-config replication (see the ADR's
 * `## Not done`). Each machine is told who it defers to, and the deterministic
 * idempotency key is what makes a momentary disagreement harmless.
 *
 * Renders nothing when no remote host is registered — on a single-machine
 * install there is nobody to hand timing to, and a select with one option is a
 * control that lies about having a choice.
 */

import { useCallback, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { GavelIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { authorityHostLiveness } from "@/lib/placement/authority-host"
import {
  getExecutionAuthorityConfigServerSnapshot,
  getExecutionAuthorityConfigSnapshot,
  resolveExecutionAuthority,
  subscribeExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
  type ExecutionAuthorityConfig,
} from "@/lib/placement/authority"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

/** The grace windows the ADR calls for: short enough to notice, long enough to sleep through. */
export const AUTHORITY_GRACE_OPTIONS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

const SELF_VALUE = "__self__"

export interface SchedulerAuthorityControlProps {
  className?: string
  /** Injected in tests so a case can drive a fixed clock. */
  now?: () => number
  /** Injected in tests; production re-arms the live scheduler. */
  onConfigChange?: (config: ExecutionAuthorityConfig) => void | Promise<void>
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

export function SchedulerAuthorityControl({
  className,
  now,
  onConfigChange,
}: SchedulerAuthorityControlProps) {
  const t = useTranslations("scheduler.authority")
  const hosts = useRemoteHostStore((state) => state.hosts)
  // The config lives in localStorage, which is unreadable during the
  // static-export render pass — `useSyncExternalStore` is what makes the
  // prerendered default and the post-hydration stored value agree, and it also
  // picks up a write from another tab.
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

  if (hosts.length === 0) return null

  const clock = now ?? Date.now
  const selected = config.hostId ? hosts.find((host) => host.id === config.hostId) : undefined
  // A configured host that has since been removed is still the configured
  // authority — silently snapping back to "this device" would hide a schedule
  // that the user believes is owned elsewhere.
  const authorityLabel = selected?.label ?? config.hostId ?? ""
  const decision = config.hostId
    ? resolveExecutionAuthority({
        config,
        authorityLiveness: authorityHostLiveness(config.hostId),
        now: clock(),
      })
    : null

  const status = ((): { text: string; tone: "muted" | "warning" } | null => {
    if (!decision) return null
    if (decision.degraded) {
      return {
        text:
          decision.unreachableForMs === undefined
            ? t("statusUnknown", { host: authorityLabel })
            : t("statusTakenOver", {
                host: authorityLabel,
                minutes: Math.round(decision.unreachableForMs / 60_000),
              }),
        tone: "warning",
      }
    }
    if (!decision.isAuthority && decision.unreachableForMs !== undefined) {
      return {
        text: t("statusWaiting", {
          host: authorityLabel,
          minutes: Math.max(
            0,
            Math.round((config.degradeAfterMs - decision.unreachableForMs) / 60_000)
          ),
        }),
        tone: "warning",
      }
    }
    return { text: t("statusStoodDown", { host: authorityLabel }), tone: "muted" }
  })()

  return (
    <div
      className={["flex flex-wrap items-center gap-2 text-xs", className ?? ""].join(" ")}
      data-testid="scheduler-authority-control"
    >
      <GavelIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <Label htmlFor="scheduler-authority-host" className="text-xs font-medium">
        {t("label")}
      </Label>
      <Select
        value={config.hostId ?? SELF_VALUE}
        onValueChange={(value) => apply({ ...config, hostId: value === SELF_VALUE ? null : value })}
      >
        <SelectTrigger
          id="scheduler-authority-host"
          size="sm"
          className="h-7 w-auto min-w-[10rem] text-xs"
          aria-label={t("label")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SELF_VALUE}>{t("thisHost")}</SelectItem>
          {hosts.map((host) => (
            <SelectItem key={host.id} value={host.id}>
              {host.label || host.config.baseUrl}
            </SelectItem>
          ))}
          {selected === undefined && config.hostId ? (
            <SelectItem value={config.hostId}>
              {t("unknownHost", { host: config.hostId })}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      <Label htmlFor="scheduler-authority-grace" className="text-xs font-medium">
        {t("graceLabel")}
      </Label>
      <Select
        value={String(config.degradeAfterMs)}
        disabled={config.hostId === null}
        onValueChange={(value) => apply({ ...config, degradeAfterMs: Number(value) })}
      >
        <SelectTrigger
          id="scheduler-authority-grace"
          size="sm"
          className="h-7 w-auto min-w-[7rem] text-xs"
          aria-label={t("graceLabel")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTHORITY_GRACE_OPTIONS_MS.map((ms) => (
            <SelectItem key={ms} value={String(ms)}>
              {t("graceMinutes", { minutes: ms / 60_000 })}
            </SelectItem>
          ))}
          {AUTHORITY_GRACE_OPTIONS_MS.every((ms) => ms !== config.degradeAfterMs) ? (
            // A config written before these options existed must stay visible
            // rather than being silently rewritten to a value nobody chose.
            <SelectItem value={String(config.degradeAfterMs)}>
              {t("graceMinutes", { minutes: Math.round(config.degradeAfterMs / 60_000) })}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      {status ? (
        <span
          className={
            status.tone === "warning"
              ? "text-amber-600 dark:text-amber-500"
              : "text-muted-foreground"
          }
          data-testid="scheduler-authority-status"
          data-tone={status.tone}
        >
          {status.text}
        </span>
      ) : null}
    </div>
  )
}
