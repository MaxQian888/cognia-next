"use client"

/**
 * Every write the device console can make to a paired device.
 *
 * Lifted out of `paired-devices-card.tsx` so the console owns them and the
 * card can be retired without losing behaviour. Three properties are load
 * bearing and are preserved exactly:
 *
 *  1. **Enabling is gated, disabling is not.** Granting hands out privilege
 *     and goes through the biometric guard; revoking reduces it and applies
 *     immediately. Gating the disabling direction would mean a user who cannot
 *     pass the biometric cannot take a permission away, which is backwards.
 *  2. **Every write is a dual write** — Dexie mirror plus the host. The host is
 *     what the request path actually reads; the mirror is what shells that
 *     cannot reach the host fall back to.
 *  3. **Turning off remote control also turns off Locked Use.** The native
 *     lease validator requires both, so leaving the Locked Use bit set behind
 *     a withdrawn control grant stores a permission that reads as granted and
 *     enforces as denied.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  pausePairedDevice,
  resumePairedDevice,
  revokePairedDevice,
  setAgentControlAllowed,
  setLockedComputerUseAllowed,
  setRemoteControlAllowed,
} from "@/lib/db/paired-devices"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useRemoteTerminalGrantToggle } from "@/hooks/companion/use-remote-terminal-grant"
import { isTauri, transport } from "@/lib/tauri"

async function hostCall(command: string, args: Record<string, unknown>): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>(command, args)
}

export interface DeviceGrantActions {
  toggleRemoteControl: (deviceId: string, label: string, next: boolean) => Promise<void>
  toggleAgentControl: (deviceId: string, label: string, next: boolean) => Promise<void>
  toggleRemoteTerminal: (
    deviceId: string,
    pubkey: string,
    label: string,
    next: boolean
  ) => Promise<void>
  toggleLockedComputerUse: (deviceId: string, label: string, next: boolean) => Promise<void>
  pause: (deviceId: string, label: string) => Promise<void>
  resume: (deviceId: string, label: string) => Promise<void>
  revoke: (deviceId: string, label: string) => Promise<void>
}

export function useDeviceGrantActions(onChanged?: () => void | Promise<void>): DeviceGrantActions {
  const guard = useBiometricGuard()
  const t = useTranslations("mobile.companion.paired")
  const tRev = useTranslations("mobile.companion.revoke")
  const tPause = useTranslations("mobile.companion.pause")
  const tResume = useTranslations("mobile.companion.resume")
  const tRc = useTranslations("mobile.companion.remoteControl")
  const tAc = useTranslations("mobile.companion.agentControl")
  const tLocked = useTranslations("mobile.companion.lockedComputerUse")

  const notifyChanged = useCallback(async () => {
    await onChanged?.()
  }, [onChanged])

  const toggleRemoteControl = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      if (!next) {
        // Locked Use first: it is only meaningful together with control, and
        // the native lease validator requires both.
        await setLockedComputerUseAllowed(deviceId, false)
        await hostCall("companion_set_locked_computer_use", { deviceId, allowed: false })
        await setRemoteControlAllowed(deviceId, false)
        await hostCall("companion_set_remote_control", { deviceId, allowed: false })
        await notifyChanged()
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
          await hostCall("companion_set_remote_control", { deviceId, allowed: true })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tRc("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(tRc("enabledToast", { label }))
    },
    [guard, notifyChanged, tRc]
  )

  const toggleAgentControl = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      // Strictly more sensitive than remote control: this lets the device start
      // processes on this machine. The spawn policy still bounds which binary,
      // working directory and environment — but within that, the device
      // decides what runs.
      if (!next) {
        await setAgentControlAllowed(deviceId, false)
        await hostCall("companion_set_agent_control", { deviceId, allowed: false })
        await notifyChanged()
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
          await hostCall("companion_set_agent_control", { deviceId, allowed: true })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tAc("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(tAc("enabledToast", { label }))
    },
    [guard, notifyChanged, tAc]
  )

  // Shared with the terminal share dialog (ADR-0133) so both surfaces drive the
  // one enforcement point identically — including the descriptor provisioning
  // and the rollback when the host call fails.
  const toggleRemoteTerminal = useRemoteTerminalGrantToggle(notifyChanged)

  const toggleLockedComputerUse = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      if (!next) {
        await setLockedComputerUseAllowed(deviceId, false)
        await hostCall("companion_set_locked_computer_use", { deviceId, allowed: false })
        await notifyChanged()
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
          await hostCall("companion_set_locked_computer_use", { deviceId, allowed: true })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tLocked("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(tLocked("enabledToast", { label }))
    },
    [guard, notifyChanged, tLocked]
  )

  const pause = useCallback(
    async (deviceId: string, label: string) => {
      // Same biometric gate as revoke: Rust treats pause as a deny-list entry,
      // so without the gate an attacker at a momentarily-unlocked desktop could
      // silently disable every paired phone.
      const result = await guard(
        {
          reason: tPause("reason", { label }),
          title: tPause("title"),
          description: tPause("description"),
        },
        async () => {
          await pausePairedDevice(deviceId)
          await hostCall("companion_revoke_device", { deviceId })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tPause("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(t("toastPaused", { label }))
    },
    [guard, notifyChanged, t, tPause]
  )

  const resume = useCallback(
    async (deviceId: string, label: string) => {
      // Resume undoes the deny-list entry pause put in place — gate it on the
      // same biometric so a paused row can only be revived by the person
      // physically holding the desktop.
      const result = await guard(
        {
          reason: tResume("reason", { label }),
          title: tResume("title"),
          description: tResume("description"),
        },
        async () => {
          await resumePairedDevice(deviceId)
          await hostCall("companion_unrevoke_device", { deviceId })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tResume("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(t("toastResumed", { label }))
    },
    [guard, notifyChanged, t, tResume]
  )

  const revoke = useCallback(
    async (deviceId: string, label: string) => {
      const result = await guard(
        {
          reason: tRev("reason", { label }),
          title: tRev("title"),
          description: tRev("description"),
        },
        async () => {
          await revokePairedDevice(deviceId)
          await hostCall("companion_revoke_device", { deviceId })
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tRev("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(tRev("successToast"))
    },
    [guard, notifyChanged, tRev]
  )

  return {
    toggleRemoteControl,
    toggleAgentControl,
    toggleRemoteTerminal,
    toggleLockedComputerUse,
    pause,
    resume,
    revoke,
  }
}
