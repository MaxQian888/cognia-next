"use client"

/**
 * Who this device is, and whether we can currently reach it.
 *
 * Returns cards rather than one block: identity, presence, the live event
 * plane and the connection are four independent questions, and on a wide pane
 * they sit side by side instead of forcing a scroll past the two nobody asked
 * about. The event-plane card only exists when there is presence to show, so
 * an absent one is information rather than an empty frame.
 *
 * Two things here were previously underivable from any surface. Live presence
 * (`eventPlane` / `attention` / open streams) has been maintained by
 * `device-presence-registry` since remote attach landed, with a docblock
 * stating plainly that no surface renders it. And a host/mirror disagreement
 * about lifecycle state was invisible: a device suspended through the
 * `cognia-server devices` CLI still read "active" here while every call from
 * it was refused.
 */

import { ActivityIcon, CopyIcon, IdCardIcon, RadioIcon, RouteIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { DeviceRow } from "@/lib/devices/types"

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

export function OverviewSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  const absolute = useDeviceAbsoluteTime()

  const copyFingerprint = async () => {
    if (!row.fingerprint) return
    await navigator.clipboard.writeText(row.fingerprint)
    toast.success(t("overview.fingerprintCopied"))
  }

  return (
    <>
      <DeviceSection id="identity" title={t("overview.identity")} icon={IdCardIcon}>
        <DeviceFactList>
          <DeviceFactRow label={t("overview.kind")}>
            <DeviceKindLabel kind={row.kind} />
          </DeviceFactRow>
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
        </DeviceFactList>
      </DeviceSection>

      {row.presence ? (
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
                  <span className="text-muted-foreground">
                    {t(`eventStreamState.${stream.state}`)}
                  </span>
                  <span className="text-muted-foreground/80">{relative(stream.openedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[11px] text-muted-foreground">{t("overview.noStreams")}</p>
          )}
        </DeviceSection>
      ) : null}

      {row.baseUrl || row.fingerprint ? (
        <DeviceSection id="connection" title={t("overview.connection")} icon={RouteIcon}>
          <DeviceFactList>
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
          </DeviceFactList>
        </DeviceSection>
      ) : null}
    </>
  )
}
