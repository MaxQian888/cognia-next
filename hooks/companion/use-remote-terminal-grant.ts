"use client"

/**
 * The per-device **remote terminal** grant, shared by the paired-devices card
 * (Settings → Companion) and the terminal share dialog (ADR-0131).
 *
 * One grant, one enforcement point: `terminal.open` in the host's
 * SecurityStore, rechecked every second by the LAN/WAN terminal adapters so
 * removing it disconnects a live attachment within a second. Both surfaces
 * MUST drive the same flow — provision a host descriptor, mirror to Dexie,
 * then flip the host — or the two would drift the way the old Dexie-only
 * switches did. Extracted here rather than duplicated.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { setRemoteTerminalAllowed } from "@/lib/db/paired-devices"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { isTauri, transport } from "@/lib/tauri"
import type { TerminalHostDescriptor } from "@/types/mobile/paired-device"

/** Which elevated grants a device holds, as reported by the host's SecurityStore. */
export interface DeviceGrantSummary {
  deviceId: string
  control: boolean
  agentControl: boolean
  terminal: boolean
}

export async function setRemoteTerminalRustSide(deviceId: string, allowed: boolean): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_set_remote_terminal", { deviceId, allowed })
}

export async function provisionTerminalHostDescriptor(
  deviceId: string,
  devicePublicKey: string
): Promise<TerminalHostDescriptor> {
  const status = await transport.call<{ descriptor?: TerminalHostDescriptor }>(
    "terminal_host_service",
    {
      action: {
        kind: "provision",
        deviceId,
        devicePublicKey,
      },
    }
  )
  if (!status.descriptor) {
    throw new Error("terminal host did not return a descriptor")
  }
  return status.descriptor
}

/**
 * Read the elevated grants from the host rather than the Dexie mirror.
 *
 * The mirror is written alongside each toggle, but it is not the authority —
 * the host's SecurityStore is, and it also moves when a device is enrolled
 * (owner devices start with the full set) or when the `cognia-server devices`
 * CLI is used. Rendering the mirror would put the switch position and the
 * permission it describes out of sync, which is the same class of bug as a
 * toggle writing a store nobody reads.
 *
 * Falls back to the mirror (`undefined`) when the host cannot be asked
 * (web/mobile shells, where `transport.call` has no Tauri backend).
 */
export async function readDeviceGrants(): Promise<Map<string, DeviceGrantSummary> | undefined> {
  if (!isTauri()) return undefined
  try {
    const rows = await transport.call<DeviceGrantSummary[]>("companion_list_device_grants")
    // A host that answers with nothing is not an error — it just cannot tell
    // us, so fall back to the mirror rather than rendering every grant off.
    return Array.isArray(rows) ? new Map(rows.map((row) => [row.deviceId, row])) : undefined
  } catch (err) {
    // Showing the mirror is better than showing nothing, but never silently:
    // a stale switch is exactly what this hook exists to prevent.
    console.warn("companion_list_device_grants failed", err)
    return undefined
  }
}

export function useDeviceGrants(): {
  grants: Map<string, DeviceGrantSummary> | undefined
  refresh: () => Promise<void>
} {
  const [grants, setGrants] = useState<Map<string, DeviceGrantSummary> | undefined>(undefined)
  const refresh = useCallback(async () => {
    setGrants(await readDeviceGrants())
  }, [])
  useEffect(() => {
    // Settled in the callback rather than the effect body, and dropped if the
    // consumer unmounts first.
    let cancelled = false
    void readDeviceGrants().then((next) => {
      if (!cancelled) setGrants(next)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return { grants, refresh }
}

export type ToggleRemoteTerminal = (
  deviceId: string,
  devicePublicKey: string,
  label: string,
  next: boolean
) => Promise<void>

/**
 * Enable / disable the remote terminal grant for one device.
 *
 * Enabling is the sensitive direction (it lets the device attach to every
 * hosted terminal and contend for the controller lease), so it sits behind the
 * biometric guard and provisions the device's host descriptor first. Disabling
 * reduces privilege and applies at once. `onChanged` runs after either
 * direction succeeds (callers refresh their grant snapshot there).
 */
export function useRemoteTerminalGrantToggle(
  onChanged?: () => Promise<void> | void
): ToggleRemoteTerminal {
  const guard = useBiometricGuard()
  const tTerminal = useTranslations("mobile.companion.remoteTerminal")

  return useCallback<ToggleRemoteTerminal>(
    async (deviceId, devicePublicKey, label, next) => {
      if (!next) {
        await setRemoteTerminalRustSide(deviceId, false)
        await setRemoteTerminalAllowed(deviceId, false)
        await onChanged?.()
        toast.success(tTerminal("disabledToast", { label }))
        return
      }
      let result
      try {
        result = await guard(
          {
            reason: tTerminal("reason", { label }),
            title: tTerminal("title"),
            description: tTerminal("description"),
          },
          async () => {
            const descriptor = await provisionTerminalHostDescriptor(deviceId, devicePublicKey)
            await setRemoteTerminalAllowed(deviceId, true, descriptor)
            try {
              await setRemoteTerminalRustSide(deviceId, true)
            } catch (error) {
              await setRemoteTerminalAllowed(deviceId, false)
              await setRemoteTerminalRustSide(deviceId, false).catch(() => undefined)
              throw error
            }
          }
        )
      } catch {
        toast.error(tTerminal("operationFailed"))
        return
      }
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(tTerminal("blocked", { reason: result.reason }))
        return
      }
      await onChanged?.()
      toast.success(tTerminal("enabledToast", { label }))
    },
    [guard, onChanged, tTerminal]
  )
}
