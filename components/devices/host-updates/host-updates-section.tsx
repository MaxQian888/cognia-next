"use client"

/**
 * Host updates (ADR-0224 A10): the chapter of a remote host's device page
 * that shows how the host updates itself, and lets its owner steer it.
 *
 *  * **The host decides.** It checks the signed catalog, waits until nothing
 *    is running, swaps its server and brain together and proves the new
 *    version or rolls back. This chapter shows where it is in that, what it
 *    is waiting for, and how the last update ended.
 *  * **The owner steers.** The channel (which this device's Update Center
 *    pushes, and can be changed here), automatic updates, "check now" and
 *    "update now".
 *  * **A host that cannot update itself says why**: the desktop app, an
 *    unpacked archive, a process outside its OS service, or a Compose host
 *    without a deploy agent; a host from before self-update says so too.
 */

import { ArrowUpCircleIcon, RotateCwIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHostUpdate, type UseHostUpdateDeps } from "@/hooks/remote-host/use-host-update"
import type { DeviceRow } from "@/lib/devices/types"
import { managementRefOf } from "@/lib/devices/section-plan"
import {
  canInstallHostUpdate,
  type HostUpdateChannel,
  type HostUpdateIdleReport,
  type HostUpdateStatus,
} from "@/lib/remote-host/host-update"

import { DeviceSection } from "../device-section"

const CHANNELS: readonly HostUpdateChannel[] = ["stable", "beta"]

type Translate = ReturnType<typeof useTranslations>

/** The sources an update is waiting on, in words. */
export function waitingReasons(t: Translate, report: HostUpdateIdleReport): string[] {
  const reasons: string[] = []
  if (report.activeRuns === null || report.activeRuns === undefined) {
    reasons.push(t("waitingFor.unknownRuns"))
  } else if (report.activeRuns > 0) {
    reasons.push(t("waitingFor.activeRuns", { count: report.activeRuns }))
  }
  if (report.jobs > 0) reasons.push(t("waitingFor.jobs", { count: report.jobs }))
  if (report.workerSlots > 0) {
    reasons.push(t("waitingFor.workerSlots", { count: report.workerSlots }))
  }
  if (report.mutations > 0) reasons.push(t("waitingFor.mutations", { count: report.mutations }))
  if (report.adminLeases > 0) reasons.push(t("waitingFor.adminLeases"))
  return reasons
}

function phaseLine(t: Translate, status: HostUpdateStatus): string {
  const version = status.trial?.to ?? status.available?.version ?? status.currentVersion
  return t(`phase.${status.phase}`, { version, from: status.trial?.from ?? "" })
}

export function HostUpdatesSection({ row, deps }: { row: DeviceRow; deps?: UseHostUpdateDeps }) {
  const t = useTranslations("devices.hostUpdates")
  const format = useFormatter()
  const hostId = managementRefOf(row)
  const { status, unsupported, error, pending, refresh, install, configure } = useHostUpdate(
    hostId,
    deps
  )

  const report = (refusal: string | null) => {
    if (refusal) toast.error(t("actionFailed", { error: refusal }))
  }

  return (
    <DeviceSection id="host-updates" title={t("title")} icon={ArrowUpCircleIcon} wide>
      <div className="space-y-3 text-sm" data-testid="host-updates">
        {unsupported ? (
          <Alert data-testid="host-updates-unsupported">
            <AlertDescription>{t("unsupported")}</AlertDescription>
          </Alert>
        ) : !status ? (
          <p className="text-muted-foreground">
            {error ? t("unreachable", { error }) : t("loading")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t("version")}</p>
                <p className="font-medium" data-testid="host-updates-version">
                  {status.currentVersion}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="host-updates-channel" className="text-xs text-muted-foreground">
                  {t("channel")}
                </Label>
                <Select
                  value={status.channel}
                  disabled={status.install === "unmanaged" || pending !== null}
                  onValueChange={(value) =>
                    void configure({ channel: value as HostUpdateChannel }).then(report)
                  }
                >
                  <SelectTrigger
                    id="host-updates-channel"
                    size="sm"
                    className="w-32"
                    data-testid="host-updates-channel"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((channel) => (
                      <SelectItem key={channel} value={channel}>
                        {t(`channels.${channel}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("channelHint")}</p>
              </div>
              <div className="max-w-sm space-y-1">
                <div className="flex items-center gap-2">
                  <Switch
                    id="host-updates-auto"
                    checked={status.autoUpdate}
                    disabled={status.install === "unmanaged" || pending !== null}
                    onCheckedChange={(autoUpdate) => void configure({ autoUpdate }).then(report)}
                    data-testid="host-updates-auto"
                  />
                  <Label htmlFor="host-updates-auto">{t("autoUpdate")}</Label>
                </div>
                <p className="text-xs text-muted-foreground">{t("autoUpdateHint")}</p>
              </div>
            </div>

            {status.unmanagedReason ? (
              <Alert data-testid="host-updates-unmanaged" data-reason={status.unmanagedReason}>
                <AlertDescription>{t(`unmanaged.${status.unmanagedReason}`)}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1" data-testid="host-updates-phase" data-phase={status.phase}>
              <p>{phaseLine(t, status)}</p>
              {status.installRequested && status.phase === "available" ? (
                <p className="text-muted-foreground">{t("installRequested")}</p>
              ) : null}
              {status.phase === "waiting-for-idle" && status.waitingFor ? (
                <p className="text-muted-foreground" data-testid="host-updates-waiting">
                  {t("waitingFor.label", {
                    reasons: waitingReasons(t, status.waitingFor).join(", "),
                  })}
                </p>
              ) : null}
              {status.lastError ? (
                <p className="text-destructive" data-testid="host-updates-error">
                  {t("lastError", { error: status.lastError })}
                </p>
              ) : null}
              {status.lastOutcome ? (
                <p className="text-muted-foreground" data-testid="host-updates-outcome">
                  {t(`outcome.${status.lastOutcome.result}`, {
                    from: status.lastOutcome.from,
                    to: status.lastOutcome.to,
                    reason: status.lastOutcome.reason ?? "",
                    when: format.relativeTime(status.lastOutcome.atMs),
                  })}
                </p>
              ) : null}
              {status.lastCheckedAt ? (
                <p className="text-xs text-muted-foreground">
                  {t("lastChecked", { when: format.relativeTime(status.lastCheckedAt) })}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void refresh().then(report)}
                data-testid="host-updates-check"
              >
                <RotateCwIcon aria-hidden className="size-3.5" />
                {t("checkNow")}
              </Button>
              {canInstallHostUpdate(status) ? (
                <Button
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void install().then(report)}
                  data-testid="host-updates-install"
                >
                  <ArrowUpCircleIcon aria-hidden className="size-3.5" />
                  {t("updateNow")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </DeviceSection>
  )
}
