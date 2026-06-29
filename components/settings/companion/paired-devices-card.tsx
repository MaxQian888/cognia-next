"use client"

/**
 * Paired devices card — read-write surface listing every device that has
 * paired with this desktop, with revoke / pause / resume actions gated
 * behind the biometric guard. Extracted from `companion-section.tsx` so
 * mobile (`/me/devices`) can wrap the same component without dragging in
 * the rest of the desktop pairing chrome.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PauseIcon, PlayIcon, RefreshCwIcon, TrashIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  listPairedDevices,
  pausePairedDevice,
  resumePairedDevice,
  revokePairedDevice,
  setRemoteControlAllowed,
} from "@/lib/db/paired-devices"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { formatRelative } from "@cognia/time"
import { isTauri, transport } from "@/lib/tauri"

async function revokeDeviceRustSide(deviceId: string): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_revoke_device", { deviceId })
}

async function unrevokeDeviceRustSide(deviceId: string): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_unrevoke_device", { deviceId })
}

async function setRemoteControlRustSide(deviceId: string, allowed: boolean): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_set_remote_control", { deviceId, allowed })
}

export function PairedDevicesCard() {
  const rows = useLiveQuery(() => listPairedDevices(), [], [])
  const guard = useBiometricGuard()
  const t = useTranslations("mobile.companion.paired")
  const tRev = useTranslations("mobile.companion.revoke")
  const tPause = useTranslations("mobile.companion.pause")
  const tResume = useTranslations("mobile.companion.resume")
  const tRc = useTranslations("mobile.companion.remoteControl")

  const onRevoke = useCallback(
    async (deviceId: string, label: string) => {
      const result = await guard(
        {
          reason: tRev("reason", { label }),
          title: tRev("title"),
          description: tRev("description"),
        },
        async () => {
          await revokePairedDevice(deviceId)
          await revokeDeviceRustSide(deviceId)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tRev("blocked", { reason: result.reason }))
        return
      }
      toast.success(tRev("successToast"))
    },
    [guard, tRev]
  )

  const onPause = useCallback(
    async (deviceId: string, label: string) => {
      // Same biometric gate as revoke: Rust treats pause as a deny-list
      // entry (companion_revoke_device) — without the gate an attacker at
      // a momentarily-unlocked desktop could silently disable every
      // paired phone.
      const result = await guard(
        {
          reason: tPause("reason", { label }),
          title: tPause("title"),
          description: tPause("description"),
        },
        async () => {
          await pausePairedDevice(deviceId)
          await revokeDeviceRustSide(deviceId)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tPause("blocked", { reason: result.reason }))
        return
      }
      toast.success(t("toastPaused", { label }))
    },
    [guard, t, tPause]
  )

  const onToggleRemoteControl = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      // Enabling is the sensitive direction — it grants the device the power
      // to drive and steer host-owned agent sessions and approve host
      // computer-use, so gate it on the biometric. Disabling reduces
      // privilege and applies immediately without a prompt.
      if (!next) {
        await setRemoteControlAllowed(deviceId, false)
        await setRemoteControlRustSide(deviceId, false)
        toast.success(tRc("disabledToast", { label }))
        return
      }
      const result = await guard(
        {
          reason: tRc("reason", { label }),
          title: tRc("title"),
          description: tRc("description"),
        },
        async () => {
          await setRemoteControlAllowed(deviceId, true)
          await setRemoteControlRustSide(deviceId, true)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tRc("blocked", { reason: result.reason }))
        return
      }
      toast.success(tRc("enabledToast", { label }))
    },
    [guard, tRc]
  )

  const onResume = useCallback(
    async (deviceId: string, label: string) => {
      // Resume undoes the deny-list entry pause put in place — gate it on
      // the same biometric so a paused row can only be revived by the
      // person physically holding the desktop.
      const result = await guard(
        {
          reason: tResume("reason", { label }),
          title: tResume("title"),
          description: tResume("description"),
        },
        async () => {
          await resumePairedDevice(deviceId)
          await unrevokeDeviceRustSide(deviceId)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tResume("blocked", { reason: result.reason }))
        return
      }
      toast.success(t("toastResumed", { label }))
    },
    [guard, t, tResume]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!rows || rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="max-h-[360px] overflow-x-auto overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">{t("colLabel")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("colPlatform")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("colFingerprint")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("colPaired")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("colLastSeen")}</TableHead>
                  <TableHead className="whitespace-nowrap text-center">{tRc("col")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap text-right">
                    {t("colActions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.deviceId}>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-2">
                        <span>{row.label}</span>
                        {row.revokedAt !== undefined && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("revoked")}
                          </Badge>
                        )}
                        {row.revokedAt === undefined && row.pausedAt !== undefined && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("paused")}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        v{row.appVersion}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs uppercase">{row.platform}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {row.serverFingerprint ? (
                        <span
                          title={row.serverFingerprint}
                          className="cursor-help"
                          aria-label={t("fingerprintAria", {
                            fingerprint: row.serverFingerprint,
                          })}
                        >
                          {row.serverFingerprint.slice(0, 12)}…
                        </span>
                      ) : (
                        <span className="italic text-muted-foreground/60">{t("unpinned")}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(row.pairedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(row.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={row.allowRemoteControl === true}
                        disabled={row.revokedAt !== undefined}
                        onCheckedChange={(next) =>
                          onToggleRemoteControl(row.deviceId, row.label, next)
                        }
                        aria-label={tRc("toggleAria", { label: row.label })}
                        data-testid={`paired-device-remote-control-${row.deviceId}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {row.revokedAt === undefined &&
                          (row.pausedAt !== undefined ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onResume(row.deviceId, row.label)}
                              aria-label={t("resumeAria", { label: row.label })}
                              data-testid={`paired-device-resume-${row.deviceId}`}
                            >
                              <PlayIcon className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onPause(row.deviceId, row.label)}
                              aria-label={t("pauseAria", { label: row.label })}
                              data-testid={`paired-device-pause-${row.deviceId}`}
                            >
                              <PauseIcon className="h-3.5 w-3.5" />
                            </Button>
                          ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onRevoke(row.deviceId, row.label)}
                          disabled={row.revokedAt !== undefined}
                          aria-label={t("revokeAria", { label: row.label })}
                          data-testid={`paired-device-revoke-${row.deviceId}`}
                        >
                          {row.revokedAt !== undefined ? (
                            <RefreshCwIcon className="h-3.5 w-3.5" />
                          ) : (
                            <TrashIcon className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
