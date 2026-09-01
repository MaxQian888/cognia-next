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
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import { useRemoteTerminalGrantToggle } from "@/hooks/companion/use-remote-terminal-grant"
import { isTauri, transport } from "@/lib/tauri"

/**
 * Raised when the enforcement side cannot be reached from this shell.
 *
 * Every command below is `target: "client"` with `transports: ["internal"]` in
 * `protocol/companion-commands.json`: it is written by the desktop renderer
 * through Tauri IPC and by nothing else. A phone or a browser tab genuinely
 * cannot make these writes, and that is a sentence to say rather than a call to
 * skip.
 */
export class DeviceGrantHostUnreachableError extends Error {
  constructor(readonly command: string) {
    super(`${command} is written by the desktop shell, which this is not`)
    this.name = "DeviceGrantHostUnreachableError"
  }
}

/**
 * Write one grant to the host's own SecurityStore.
 *
 * This used to `return` when `isTauri()` was false, which meant a device
 * console open on a phone wrote the Dexie mirror, skipped the host, and showed
 * a success toast for a grant nobody made. The switch then read back as
 * enabled from the mirror it had just written. Throwing is what lets the caller
 * roll back and say so.
 */
async function hostCall(command: string, args: Record<string, unknown>): Promise<void> {
  if (!isTauri()) throw new DeviceGrantHostUnreachableError(command)
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

/**
 * Run a grant action, turning a host refusal into a toast.
 *
 * Every action below writes the host FIRST and the Dexie mirror second, so a
 * refusal leaves nothing written and there is nothing to roll back. What was
 * missing was a place for the refusal to land: `guard` re-throws whatever its
 * action throws, and each of these is called as `void actions.pause(...)` from
 * an onClick, so the rejection was unhandled and the user saw nothing at all.
 *
 * `label` is the second argument of every action this wraps.
 * `toggleRemoteTerminal` is deliberately NOT wrapped: it comes from
 * `useRemoteTerminalGrantToggle`, which reports its own refusals and rolls back
 * its own descriptor provisioning.
 */
function reportingHostFailures<A extends [string, string, ...unknown[]]>(
  fn: (...args: A) => Promise<void>,
  onFailure: (error: unknown, label: string) => void
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (error) {
      onFailure(error, args[1])
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useDeviceGrantActions(onChanged?: () => void | Promise<void>): DeviceGrantActions {
  const guard = useBiometricGuard()
  // Settings → Security → "Require biometrics to delete a pairing". `revoke`
  // used to prompt unconditionally, so switching the row off changed nothing —
  // the only surface that reads the flag is the settings page that writes it.
  //
  // Only `revoke` is keyed on the policy. The capability toggles below have no
  // row in that panel and stay gated unconditionally: handing a remote device
  // control of this machine is not a preference the panel offers to waive.
  const requireBiometricForRevoke =
    useSettingsStore((s) => s.settings?.biometricRequiredFor?.deletePairing) ??
    DEFAULT_BIOMETRIC_GUARD.deletePairing
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
        await hostCall("companion_set_locked_computer_use", { deviceId, allowed: false })
        await setLockedComputerUseAllowed(deviceId, false)
        await hostCall("companion_set_remote_control", { deviceId, allowed: false })
        await setRemoteControlAllowed(deviceId, false)
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
          await hostCall("companion_set_remote_control", { deviceId, allowed: true })
          await setRemoteControlAllowed(deviceId, true)
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
        await hostCall("companion_set_agent_control", { deviceId, allowed: false })
        await setAgentControlAllowed(deviceId, false)
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
          await hostCall("companion_set_agent_control", { deviceId, allowed: true })
          await setAgentControlAllowed(deviceId, true)
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
        await hostCall("companion_set_locked_computer_use", { deviceId, allowed: false })
        await setLockedComputerUseAllowed(deviceId, false)
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
          await hostCall("companion_set_locked_computer_use", { deviceId, allowed: true })
          await setLockedComputerUseAllowed(deviceId, true)
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
      // Same biometric gate as revoke: without it an attacker at a
      // momentarily-unlocked desktop could silently disable every paired phone.
      //
      // `companion_suspend_device`, not `companion_revoke_device`. Pause used
      // to write the deny list through the revoke arm, which meant a paused
      // device was a revoked device: revoke tears down the signaling
      // registration and revokes the device key, so the row came back only
      // after re-pairing. `companion_unrevoke_device` says as much in its own
      // docblock — un-revoke "never actually undid anything". Suspend keeps
      // the identity, which is what makes Resume below able to mean something.
      const result = await guard(
        {
          reason: tPause("reason", { label }),
          title: tPause("title"),
          description: tPause("description"),
        },
        async () => {
          await hostCall("companion_suspend_device", { deviceId })
          await pausePairedDevice(deviceId)
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
      // Lifts the suspension pause put in place — gate it on the same
      // biometric so a paused row can only be revived by the person physically
      // holding the desktop.
      //
      // The canonical name. `companion_unrevoke_device` maps to the same
      // `LifecycleAction::Resume` and stays registered because the plugin API
      // surface calls it, but naming the action the host actually performs is
      // what lets a reader tell suspend from revoke here.
      const result = await guard(
        {
          reason: tResume("reason", { label }),
          title: tResume("title"),
          description: tResume("description"),
        },
        async () => {
          await hostCall("companion_resume_device", { deviceId })
          await resumePairedDevice(deviceId)
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
      const doRevoke = async () => {
        await hostCall("companion_revoke_device", { deviceId })
        await revokePairedDevice(deviceId)
      }
      if (!requireBiometricForRevoke) {
        await doRevoke()
        await notifyChanged()
        toast.success(tRev("successToast"))
        return
      }
      const result = await guard(
        {
          reason: tRev("reason", { label }),
          title: tRev("title"),
          description: tRev("description"),
        },
        doRevoke
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tRev("blocked", { reason: result.reason }))
        return
      }
      await notifyChanged()
      toast.success(tRev("successToast"))
    },
    [guard, notifyChanged, requireBiometricForRevoke, tRev]
  )

  // Wrapped at the boundary rather than inside each body: the seven actions
  // already differ in their success and "blocked" toasts, and a refusal reads
  // the same for all of them.
  const wrap = <A extends [string, string, ...unknown[]]>(fn: (...args: A) => Promise<void>) =>
    reportingHostFailures(fn, (error, label) => {
      toast.error(
        error instanceof DeviceGrantHostUnreachableError
          ? t("hostOnly", { label })
          : t("hostRefused", { label, reason: describeError(error) })
      )
    })

  return {
    toggleRemoteControl: wrap(toggleRemoteControl),
    toggleAgentControl: wrap(toggleAgentControl),
    toggleRemoteTerminal,
    toggleLockedComputerUse: wrap(toggleLockedComputerUse),
    pause: wrap(pause),
    resume: wrap(resume),
    revoke: wrap(revoke),
  }
}
