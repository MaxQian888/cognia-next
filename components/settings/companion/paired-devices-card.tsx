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
  setAgentControlAllowed,
  setLockedComputerUseAllowed,
  setRemoteControlAllowed,
} from "@/lib/db/paired-devices"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import {
  useDeviceGrants,
  useRemoteTerminalGrantToggle,
} from "@/hooks/companion/use-remote-terminal-grant"
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

async function setAgentControlRustSide(deviceId: string, allowed: boolean): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_set_agent_control", { deviceId, allowed })
}

async function setLockedComputerUseRustSide(deviceId: string, allowed: boolean): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_set_locked_computer_use", { deviceId, allowed })
}

/**
 * Whether Locked Use can be granted at all on this build.
 *
 * `false` because the grant has no enforcement point yet: the policy core
 * (`LockedUseController`) is complete, but the macOS edges it sits behind — the
 * XPC service, the guardian windows, the Authorization Plugin — have not
 * shipped, so nothing ever consumes the grant. The switch is therefore inert
 * and labelled, rather than implying a permission is being handed out.
 *
 * This is the UI axis of the dormancy contract in CLAUDE.md Working Rule 7.
 * Flipping it to `true` is one of three edits that must land together — see
 * `src-tauri/src/companion_api/locked_use_allow_list.rs`, whose module docs and
 * dormancy test name the other two.
 */
const LOCKED_USE_AVAILABLE = false

export function PairedDevicesCard() {
  const rows = useLiveQuery(() => listPairedDevices(), [], [])
  const { grants, refresh: refreshGrants } = useDeviceGrants()
  const guard = useBiometricGuard()
  const t = useTranslations("mobile.companion.paired")
  const tRev = useTranslations("mobile.companion.revoke")
  const tPause = useTranslations("mobile.companion.pause")
  const tResume = useTranslations("mobile.companion.resume")
  const tRc = useTranslations("mobile.companion.remoteControl")
  const tAc = useTranslations("mobile.companion.agentControl")
  const tTerminal = useTranslations("mobile.companion.remoteTerminal")
  const tLocked = useTranslations("mobile.companion.lockedComputerUse")

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
        await setLockedComputerUseAllowed(deviceId, false)
        await setLockedComputerUseRustSide(deviceId, false)
        await setRemoteControlAllowed(deviceId, false)
        await setRemoteControlRustSide(deviceId, false)
        await refreshGrants()
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
      await refreshGrants()
      toast.success(tRc("enabledToast", { label }))
    },
    [guard, refreshGrants, tRc]
  )

  const onToggleAgentControl = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      // Strictly more sensitive than remote control: this lets the device start
      // processes on this machine. The spawn policy still bounds which binary,
      // which working directory and which environment variables — but within
      // that, the device decides what runs. Same biometric gate on the
      // enabling direction; disabling reduces privilege and applies at once.
      if (!next) {
        await setAgentControlAllowed(deviceId, false)
        await setAgentControlRustSide(deviceId, false)
        await refreshGrants()
        toast.success(tAc("disabledToast", { label }))
        return
      }
      const result = await guard(
        {
          reason: tAc("reason", { label }),
          title: tAc("title"),
          description: tAc("description"),
        },
        async () => {
          await setAgentControlAllowed(deviceId, true)
          await setAgentControlRustSide(deviceId, true)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tAc("blocked", { reason: result.reason }))
        return
      }
      await refreshGrants()
      toast.success(tAc("enabledToast", { label }))
    },
    [guard, refreshGrants, tAc]
  )

  // Shared with the terminal share dialog (ADR-0131) so both surfaces drive
  // the one enforcement point identically.
  const onToggleRemoteTerminal = useRemoteTerminalGrantToggle(refreshGrants)

  const onToggleLockedComputerUse = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      if (!next) {
        await setLockedComputerUseAllowed(deviceId, false)
        await setLockedComputerUseRustSide(deviceId, false)
        toast.success(tLocked("disabledToast", { label }))
        return
      }
      const result = await guard(
        {
          reason: tLocked("reason", { label }),
          title: tLocked("title"),
          description: tLocked("description"),
        },
        async () => {
          await setLockedComputerUseAllowed(deviceId, true)
          await setLockedComputerUseRustSide(deviceId, true)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tLocked("blocked", { reason: result.reason }))
        return
      }
      toast.success(tLocked("enabledToast", { label }))
    },
    [guard, tLocked]
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
                  <TableHead className="whitespace-nowrap text-center">{tAc("col")}</TableHead>
                  <TableHead className="whitespace-nowrap text-center">
                    {tTerminal("col")}
                  </TableHead>
                  <TableHead className="whitespace-nowrap text-center">{tLocked("col")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap text-right">
                    {t("colActions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  // The host's answer when we have it; the Dexie mirror only
                  // as a fallback for shells that cannot reach the host.
                  const grant = grants?.get(row.deviceId)
                  return (
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
                          checked={grant ? grant.control : row.allowRemoteControl === true}
                          disabled={row.revokedAt !== undefined}
                          onCheckedChange={(next) =>
                            onToggleRemoteControl(row.deviceId, row.label, next)
                          }
                          aria-label={tRc("toggleAria", { label: row.label })}
                          data-testid={`paired-device-remote-control-${row.deviceId}`}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={grant ? grant.agentControl : row.allowAgentControl === true}
                          disabled={row.revokedAt !== undefined}
                          onCheckedChange={(next) =>
                            onToggleAgentControl(row.deviceId, row.label, next)
                          }
                          aria-label={tAc("toggleAria", { label: row.label })}
                          data-testid={`paired-device-agent-control-${row.deviceId}`}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={grant ? grant.terminal : row.allowRemoteTerminal === true}
                          disabled={row.revokedAt !== undefined || !isTauri()}
                          onCheckedChange={(next) =>
                            onToggleRemoteTerminal(row.deviceId, row.pubkey, row.label, next)
                          }
                          aria-label={tTerminal("toggleAria", { label: row.label })}
                          data-testid={`paired-device-remote-terminal-${row.deviceId}`}
                        />
                      </TableCell>
                      {/* Inert while LOCKED_USE_AVAILABLE is false — see its docs. */}
                      <TableCell className="text-center">
                        <div className="flex flex-col items-center gap-1">
                          <Switch
                            checked={LOCKED_USE_AVAILABLE && row.allowLockedComputerUse === true}
                            disabled={
                              !LOCKED_USE_AVAILABLE ||
                              row.revokedAt !== undefined ||
                              (grant ? !grant.control : row.allowRemoteControl !== true)
                            }
                            onCheckedChange={(next) =>
                              onToggleLockedComputerUse(row.deviceId, row.label, next)
                            }
                            aria-label={tLocked("toggleAria", { label: row.label })}
                            data-testid={`paired-device-locked-computer-use-${row.deviceId}`}
                          />
                          {!LOCKED_USE_AVAILABLE && (
                            <Badge
                              variant="outline"
                              className="text-[10px] font-normal text-muted-foreground"
                            >
                              {tLocked("unavailable")}
                            </Badge>
                          )}
                        </div>
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
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
