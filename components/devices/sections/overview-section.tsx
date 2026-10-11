"use client"

/**
 * Who this device is, and whether we can currently reach it.
 *
 * Three cards rather than one block: identity, presence and the live event
 * plane are independent questions, and on a wide pane they sit side by side
 * instead of forcing a scroll past the two nobody asked about. The event-plane
 * card only exists when there is presence to show, so an absent one is
 * information rather than an empty frame.
 *
 * The address and the fingerprint used to be a fourth card of their own. They
 * are not a separate question: an address is how a machine is named and a
 * fingerprint is how that name is verified, which is what identity means. On
 * every kind but a remote host the card held exactly one row, and a card frame
 * costs more vertical space than a single fact does, so the grid ended up with
 * a 90px stub beside whichever card had real content.
 *
 * Two things here were previously underivable from any surface. Live presence
 * (`eventPlane` / `attention` / open streams) has been maintained by
 * `device-presence-registry` since remote attach landed, with a docblock
 * stating plainly that no surface renders it. And a host/mirror disagreement
 * about lifecycle state was invisible: a device suspended through the
 * `cognia-server devices` CLI still read "active" here while every call from
 * it was refused.
 */

import { ActivityIcon, CopyIcon, IdCardIcon, RadioIcon, RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { DeviceRow } from "@/lib/devices/types"
import { probeHostLiveness } from "@/lib/remote-host/liveness"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import {
  AdminStateBadge,
  DeviceFactList,
  DeviceFactRow,
  DeviceKindLabel,
  ReachabilityLabel,
  shortenFingerprint,
  useDeviceAbsoluteTime,
  useDeviceRelativeTime,
} from "../device-visuals"

/**
 * Who the device is. Three exports rather than one fragment, because the
 * dashboard places them per kind (`lib/devices/section-plan.ts`): a phone
 * leads with presence and reads identity later, a worker leads with identity.
 */
export function IdentitySection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")

  const copyFingerprint = async () => {
    if (!row.fingerprint) return
    await navigator.clipboard.writeText(row.fingerprint)
    toast.success(t("overview.fingerprintCopied"))
  }

  return (
    <DeviceSection id="identity" title={t("overview.identity")} icon={IdCardIcon}>
      <DeviceFactList>
        <DeviceFactRow label={t("overview.kind")}>
          <DeviceKindLabel kind={row.kind} />
        </DeviceFactRow>
        {row.baseUrl ? (
          <DeviceFactRow label={t("overview.baseUrl")} mono>
            {row.baseUrl}
          </DeviceFactRow>
        ) : null}
        {row.fingerprint ? (
          <DeviceFactRow label={t("overview.fingerprint")}>
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-[11px]" title={row.fingerprint}>
                {shortenFingerprint(row.fingerprint)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="size-5 p-0"
                aria-label={t("overview.copyFingerprint")}
                onClick={copyFingerprint}
                data-testid="copy-fingerprint"
              >
                <CopyIcon className="size-3" />
              </Button>
            </span>
          </DeviceFactRow>
        ) : null}
        {row.reportedPlatform ? (
          <DeviceFactRow label={t("overview.platform")} mono>
            {row.reportedPlatform}
          </DeviceFactRow>
        ) : null}
        {row.appVersion ? (
          <DeviceFactRow label={t("overview.appVersion")} mono>
            v{row.appVersion}
          </DeviceFactRow>
        ) : null}
        {row.serverVersion ? (
          <DeviceFactRow label={t("overview.serverVersion")} mono>
            v{row.serverVersion}
          </DeviceFactRow>
        ) : null}
        {row.role ? <DeviceFactRow label={t("overview.role")}>{row.role}</DeviceFactRow> : null}
        {row.hostRole ? (
          <DeviceFactRow label={t("overview.hostRole")}>
            <span data-testid="overview-host-role">{t(`hostRole.${row.hostRole}`)}</span>
          </DeviceFactRow>
        ) : null}
        {row.ownerUserId ? (
          <DeviceFactRow label={t("overview.owner")} mono={!row.ownerLabel}>
            {row.ownerLabel ?? row.ownerUserId}
          </DeviceFactRow>
        ) : row.kind === "paired-device" ? (
          // Named explicitly rather than omitted: "nobody has claimed this"
          // is a fact worth reading, and an absent row reads as "unknown".
          <DeviceFactRow label={t("overview.owner")}>{t("overview.ownerNone")}</DeviceFactRow>
        ) : null}
        <DeviceFactRow label={t("overview.adminState")}>
          {row.adminState === "active" ? (
            t("adminState.active")
          ) : (
            <AdminStateBadge state={row.adminState} />
          )}
        </DeviceFactRow>
        <DeviceFactRow label={t("overview.ref")} mono>
          {row.ref}
        </DeviceFactRow>
      </DeviceFactList>
    </DeviceSection>
  )
}

export function PresenceSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  const absolute = useDeviceAbsoluteTime()

  return (
    <DeviceSection id="presence" title={t("overview.presence")} icon={RadioIcon}>
      <DeviceFactList>
        <DeviceFactRow label={t("overview.reachability")}>
          <ReachabilityLabel reachability={row.reachability} />
        </DeviceFactRow>
        <DeviceFactRow label={t("overview.lastSeen")}>
          {row.isSelf ? t("overview.isThisDevice") : relative(row.lastSeenAt)}
        </DeviceFactRow>
        {row.pairedAt ? (
          <DeviceFactRow label={t("overview.paired")}>{absolute(row.pairedAt)}</DeviceFactRow>
        ) : null}
        {row.addedAt ? (
          <DeviceFactRow label={t("overview.added")}>{absolute(row.addedAt)}</DeviceFactRow>
        ) : null}
        {row.lastConnectedAt ? (
          <DeviceFactRow label={t("overview.lastConnected")}>
            {absolute(row.lastConnectedAt)}
          </DeviceFactRow>
        ) : null}
        {row.connectionState ? (
          <DeviceFactRow label={t("overview.connectionState")}>
            {t(`connectionState.${row.connectionState}`)}
          </DeviceFactRow>
        ) : null}
        {row.kind === "remote-host" && row.hostId ? (
          <HostLivenessFact row={row} hostId={row.hostId} />
        ) : null}
      </DeviceFactList>
    </DeviceSection>
  )
}

/**
 * The last liveness probe over the host's management channel (ADR-0224 A4),
 * and a way to ask now rather than wait for the next one. The failure text is
 * shown verbatim: "did not answer" and "refused this device" need different
 * fixes.
 */
function HostLivenessFact({ row, hostId }: { row: DeviceRow; hostId: string }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  const [checking, setChecking] = useState(false)
  const probe = row.lastProbe

  const checkNow = async () => {
    setChecking(true)
    try {
      const result = await probeHostLiveness(hostId)
      if (result?.ok) toast.success(t("overview.checkAnswered"))
      else toast.error(t("overview.checkNoAnswer", { error: result?.error ?? "" }))
    } finally {
      setChecking(false)
    }
  }

  return (
    <DeviceFactRow label={t("overview.lastCheck")}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          data-testid="overview-last-check"
          data-ok={probe ? String(probe.ok) : undefined}
          className={cn(
            "min-w-0 break-words",
            probe && !probe.ok && "text-amber-700 dark:text-amber-400"
          )}
        >
          {!probe
            ? t("overview.lastCheckNever")
            : probe.ok
              ? t("overview.lastCheckOk", { when: relative(probe.at) })
              : t("overview.lastCheckFailed", {
                  when: relative(probe.at),
                  error: probe.error ?? "",
                })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-xs"
          disabled={checking}
          onClick={() => void checkNow()}
          data-testid="overview-check-now"
        >
          <RefreshCwIcon className={cn("size-3", checking && "animate-spin")} aria-hidden="true" />
          {checking ? t("overview.checking") : t("overview.checkNow")}
        </Button>
      </span>
    </DeviceFactRow>
  )
}

/** The live event plane. Renders nothing for a device with no presence entry. */
export function EventPlaneSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  if (!row.presence) return null

  return (
    <DeviceSection
      id="event-plane"
      title={t("overview.eventPlane")}
      icon={ActivityIcon}
      meta={
        row.presence.streams.length > 0
          ? t("overview.streamCount", { count: row.presence.streams.length })
          : undefined
      }
    >
      <DeviceFactList>
        <DeviceFactRow label={t("overview.eventPlaneState")}>
          {t(`eventPlane.${row.presence.eventPlane}`)}
        </DeviceFactRow>
        <DeviceFactRow label={t("overview.attention")}>
          {t(`attention.${row.presence.attention}`)}
        </DeviceFactRow>
      </DeviceFactList>
      {row.presence.streams.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {row.presence.streams.map((stream) => (
            <li
              key={stream.leaseId}
              className="flex items-baseline justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-[11px]"
            >
              <span className="font-mono uppercase">{stream.transport}</span>
              <span className="text-muted-foreground">{t(`eventStreamState.${stream.state}`)}</span>
              <span className="text-muted-foreground/80">{relative(stream.openedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[11px] text-muted-foreground">{t("overview.noStreams")}</p>
      )}
    </DeviceSection>
  )
}
