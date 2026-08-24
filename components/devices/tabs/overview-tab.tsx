"use client"

/**
 * Who this device is, and whether we can currently reach it.
 *
 * Two things here were previously underivable from any surface. Live presence
 * (`eventPlane` / `attention` / open streams) has been maintained by
 * `device-presence-registry` since remote attach landed, with a docblock
 * stating plainly that no surface renders it. And a host/mirror disagreement
 * about lifecycle state was invisible: a device suspended through the
 * `cognia-server devices` CLI still read "active" here while every call from
 * it was refused.
 */

import { CopyIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { DeviceRow } from "@/lib/devices/types"

import { HostControls } from "../host-controls"
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

export function OverviewTab({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  const absolute = useDeviceAbsoluteTime()

  const copyFingerprint = async () => {
    if (!row.fingerprint) return
    await navigator.clipboard.writeText(row.fingerprint)
    toast.success(t("overview.fingerprintCopied"))
  }

  return (
    <div className="space-y-4" data-testid="device-overview-tab">
      {row.adminStateConflict ? (
        <Alert variant="destructive" data-testid="device-admin-conflict">
          <AlertTitle>{t("overview.conflictTitle")}</AlertTitle>
          <AlertDescription>{t("overview.conflictBody")}</AlertDescription>
        </Alert>
      ) : null}

      {row.connectionError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("overview.connectionErrorTitle")}</AlertTitle>
          <AlertDescription className="break-all">{row.connectionError}</AlertDescription>
        </Alert>
      ) : null}

      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("overview.identity")}
        </h3>
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
      </section>

      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("overview.presence")}
        </h3>
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
      </section>

      {row.presence ? (
        <section data-testid="device-event-plane">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("overview.eventPlane")}
          </h3>
          <DeviceFactList>
            <DeviceFactRow label={t("overview.eventPlaneState")}>
              {t(`eventPlane.${row.presence.eventPlane}`)}
            </DeviceFactRow>
            <DeviceFactRow label={t("overview.attention")}>
              {t(`attention.${row.presence.attention}`)}
            </DeviceFactRow>
          </DeviceFactList>
          {row.presence.streams.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {row.presence.streams.map((stream) => (
                <li
                  key={stream.leaseId}
                  className="flex items-baseline justify-between gap-2 rounded border bg-muted/20 px-2 py-1 text-[11px]"
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
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t("overview.noStreams")}</p>
          )}
        </section>
      ) : null}

      {row.baseUrl || row.fingerprint ? (
        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("overview.connection")}
          </h3>
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
                    className="size-6 p-0"
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
        </section>
      ) : null}

      <HostControls row={row} />
    </div>
  )
}
