"use client"

/**
 * Scheduler host bar — says whose schedule the page is managing and lets the
 * user flip between this device and the paired / remote host (spec 2026-08-16,
 * decision 14 / Q29). Placement is host-owned: the two schedules never merge;
 * this only switches which one the page reads and writes.
 *
 *   desktop driving a remote host → "Managing: cloud host <label>"; the local
 *     schedule is shown as suspended (the desktop scheduler is stopped while
 *     it drives a remote host) and can be viewed read-only.
 *   phone / cloud companion → defaults to the paired host (always-on); "this
 *     device" only ticks while the app is open, and the bar says so.
 *   plain desktop / web-standalone → no paired host, bar states the fact.
 *
 * Presentation is tiered by how much the bar has to say. With a paired host to
 * switch to (or a suspended local schedule) it is a bordered band carrying an
 * action; on a plain desktop it still states the fact — that is the recorded
 * decision — but as one quiet line instead of a full-width card, because that
 * case is permanent and actionless and was eating a whole row of the pane.
 *
 * Which schedule the page *reads* and which host is allowed to *fire* it are
 * two different questions. `SchedulerAuthorityControl` answers the second and
 * sits on the same row: it is the same mental model ("whose schedule is this?")
 * and splitting it into its own card would separate a choice from its context.
 */

import { useTranslations } from "next-intl"
import { CloudIcon, MonitorSmartphoneIcon, PauseCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SchedulerAuthorityControl } from "./scheduler-authority-control"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { useHostProfile } from "@/hooks/use-host-profile"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

export interface SchedulerHostBarProps {
  className?: string
}

export function SchedulerHostBar({ className }: SchedulerHostBarProps) {
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

  // Does the bar carry anything the user can act on or be surprised by?
  const isActionable = pairedAvailable || desktopDrivingRemote

  return (
    <div
      className={[
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs",
        isActionable
          ? "rounded-md border bg-muted/30 px-3 py-2"
          : "px-4 py-1.5 text-muted-foreground",
        className ?? "",
      ].join(" ")}
      data-testid="scheduler-host-bar"
      data-variant={isActionable ? "banner" : "note"}
      role="status"
    >
      {target === "paired" ? (
        <CloudIcon className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <MonitorSmartphoneIcon className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className={isActionable ? "font-medium" : undefined}>
        {t("managing", { host: target === "paired" ? pairedLabel : t("thisDevice") })}
      </span>
      {target === "local" && desktopDrivingRemote && (
        <Badge variant="outline" className="text-[10px]" data-testid="scheduler-host-bar-suspended">
          <PauseCircleIcon className="mr-1 h-3 w-3" aria-hidden="true" />
          {t("localSuspended")}
        </Badge>
      )}
      {target === "local" && !desktopDrivingRemote && pairedAvailable && (
        <span className="text-muted-foreground" data-testid="scheduler-host-bar-local-note">
          {t("localOnlyWhileOpen")}
        </span>
      )}
      {/* Only the app scheduler has cross-host RPCs (`scheduled_task_*`). The
          other four unified kinds are storage this device owns outright, so
          they keep showing local rows while a paired schedule is managed —
          said out loud rather than letting the list imply one host. */}
      {target === "paired" && (
        <span className="text-muted-foreground" data-testid="scheduler-host-bar-local-kinds">
          {t("localKindsStay")}
        </span>
      )}
      {!pairedAvailable && (
        <span className="text-muted-foreground" data-testid="scheduler-host-bar-no-paired">
          {t("noPairedHost")}
        </span>
      )}
      {pairedAvailable && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          onClick={() => setTarget(target === "paired" ? "local" : "paired")}
          data-testid="scheduler-host-bar-switch"
        >
          {target === "paired" ? t("switchToLocal") : t("switchToPaired", { host: pairedLabel })}
        </Button>
      )}
      <SchedulerAuthorityControl className={pairedAvailable ? "basis-full" : "ml-auto"} />
    </div>
  )
}
