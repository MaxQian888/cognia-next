"use client"

/**
 * Whether the desktop is holding a WAN signaling connection for this device.
 *
 * This section exists because of a reduction, not a feature. ADR-0021 costs one
 * permanent WSS socket per connected paired device (the hosted deployment
 * routes each one to a per-room Durable Object, so they cannot be multiplexed),
 * and nothing ever prunes `pairedDevices`, so a real user log showed 16
 * concurrent sockets for devices that mostly had not spoken in months. Devices
 * idle for 30 days no longer get an automatic connection.
 *
 * A silent reduction would be indistinguishable from a broken device. So, per
 * CLAUDE.md working rule 7, the row **says** that no connection is held, says
 * why, and offers the button that starts one. The button renders in every
 * state, disabled with the reason, because hiding it would merge "this device
 * can never hold one", "the master switch is off", and "one click away" into
 * the same blank space.
 *
 * The wake is deliberately not a write. It puts the device id in a
 * session-scoped override set (`lib/signaling/wan-wake-overrides.ts`), which
 * makes `installDesktopSignalingController` re-push the hub's device list with
 * it included. Nothing about the pairing changes, and if the device never
 * answers the socket is gone at the next restart.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { PlugZapIcon, RadioTowerIcon, SettingsIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DeviceRow, DeviceWanState } from "@/lib/devices/types"
import { sleepDeviceForWan, wakeDeviceForWan } from "@/lib/signaling/wan-wake-overrides"

import { DeviceSection } from "../device-section"
import { DeviceFactList, DeviceFactRow, useDeviceRelativeTime } from "../device-visuals"

/**
 * Badge tone per state. `automatic` and `woken` are the two that mean a
 * connection is held, and they are told apart rather than merged because one
 * lasts and the other does not.
 */
const TONE: Record<DeviceWanState, string> = {
  automatic: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  woken: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  dormant: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500",
  blocked: "border-destructive/30 bg-destructive/10 text-destructive",
  unprovisioned: "border-border bg-muted text-muted-foreground",
  disabled: "border-border bg-muted text-muted-foreground",
  unmanaged: "border-border bg-muted text-muted-foreground",
}

export function WanSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices.wan")
  const relative = useDeviceRelativeTime()

  const wan = row.wan
  const deviceId = row.deviceId

  // No pending state: `wakeDeviceForWan` is a synchronous write to a module-level
  // set, and the re-render it triggers lands in the same commit. A `busy` flag
  // set and cleared inside one handler is never observable, and pretending
  // otherwise only hides that the answer is already in.
  const onWake = useCallback(() => {
    if (!deviceId) return
    wakeDeviceForWan(deviceId)
  }, [deviceId])

  const onSleep = useCallback(() => {
    if (!deviceId) return
    sleepDeviceForWan(deviceId)
  }, [deviceId])

  // Every other kind of machine is reached over its own transport and never
  // costs a rendezvous socket, so there is nothing here to say about one.
  if (row.kind !== "paired-device" || !wan) return null

  return (
    <DeviceSection
      id="wan"
      title={t("title")}
      icon={RadioTowerIcon}
      description={t("description")}
      meta={
        <Badge variant="outline" className={TONE[wan.state]} data-testid="wan-state-badge">
          {t(`state.${wan.state}`)}
        </Badge>
      }
    >
      <DeviceFactList>
        <DeviceFactRow label={t("lastActivity")}>{relative(wan.lastEvidenceAt)}</DeviceFactRow>
      </DeviceFactList>

      <p className="mt-3 text-[11px] leading-snug text-muted-foreground" data-testid="wan-reason">
        {t(`reason.${wan.state}`)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/*
          Rendered in every state, never conditionally dropped. A device that
          simply has no signaling room and one that is a click away from being
          reachable are different answers, and an absent button gives both the
          same one.
        */}
        <Button
          size="sm"
          onClick={onWake}
          disabled={!wan.canWake}
          data-testid="wan-wake"
          title={wan.canWake ? undefined : t(`reason.${wan.state}`)}
        >
          <PlugZapIcon className="size-3.5" />
          {t("wake")}
        </Button>

        {wan.state === "woken" ? (
          <Button size="sm" variant="ghost" onClick={onSleep} data-testid="wan-sleep">
            {t("sleep")}
          </Button>
        ) : null}

        <Button asChild size="sm" variant="ghost" data-testid="wan-settings">
          <Link href="/settings?section=companion">
            <SettingsIcon className="size-3.5" />
            {t("settings")}
          </Link>
        </Button>
      </div>

      {/*
        The one thing this section deliberately does not claim. "A connection is
        held for this device" is a registration fact. Whether the socket is up
        this second, and which tier it reached, is the WebRTC card's live poll.
      */}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">{t("liveHint")}</p>
    </DeviceSection>
  )
}
