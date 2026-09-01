"use client"

/**
 * The per-device **remote terminal** grant, shared by the paired-devices card
 * (Settings → Companion) and the terminal share dialog (ADR-0133).
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
import { transport } from "@/lib/tauri"
import type { TerminalHostDescriptor } from "@/types/mobile/paired-device"

/** Which elevated grants a device holds, as reported by the host's SecurityStore. */
export interface DeviceGrantSummary {
  deviceId: string
  control: boolean
  agentControl: boolean
  terminal: boolean
}

/**
 * Flip the host's `terminal.open` grant for one device.
 *
 * Deliberately unguarded. This used to open with `if (!isTauri()) return`,
 * which made every shell that is not the host silently succeed: the caller
 * went on to write the Dexie mirror and toast "Terminal access disabled" while
 * the host kept serving the device. A grant that fails open is worse than one
 * that fails, and the mirror claiming a state the host does not hold is the
 * exact drift this module was extracted to prevent.
 *
 * The transport already knows the answer without a round trip.
 * `companion_set_remote_terminal` is `target: "client"`, so
 * `CompanionTransport` rejects it with `command_transport_forbidden` and
 * `WebStubTransport` rejects it too — the host's own `authorize_transport`
 * would answer 403 anyway. Letting that rejection through is what turns a lie
 * into a refusal the caller can render.
 */
export async function setRemoteTerminalRustSide(deviceId: string, allowed: boolean): Promise<void> {
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
 * Falls back to the mirror (`undefined`) when the host cannot be asked. That
 * is the transport's answer, not a shell check: `companion_list_device_grants`
 * is `target: "client"`, so a companion or web shell rejects it locally
 * without a round trip and the catch below turns the rejection into the same
 * `undefined`. One less `isTauri()` standing between a caller and a transport
 * that already knows.
 */
export async function readDeviceGrants(): Promise<Map<string, DeviceGrantSummary> | undefined> {
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

/**
 * Separate "this shell cannot change a host grant" from "the write failed".
 *
 * Both surface as a thrown call, and collapsing them would tell someone
 * standing at the host that their machine is broken, or tell someone on a
 * phone to retry something no retry can reach. The Host reuses its own
 * `command_transport_forbidden` code for the client-side refusal, so the code
 * is the same on either side of the wire.
 */
function hostRefusalMessage(error: unknown, t: (key: string) => string): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : ""
  const unreachable =
    code === "command_transport_forbidden" ||
    /tauri-only command from web mode|cannot be answered by a paired host/.test(message)
  return unreachable ? t("hostOnly") : t("operationFailed")
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
        // Host first, mirror second, and no mirror write at all if the host
        // refused. Disabling reduces privilege so it needs no biometric, but
        // it still needs to have happened: the old order wrote Dexie and
        // toasted success on a shell where the host call was a no-op.
        try {
          await setRemoteTerminalRustSide(deviceId, false)
        } catch (error) {
          toast.error(hostRefusalMessage(error, tTerminal))
          return
        }
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
      } catch (error) {
        toast.error(hostRefusalMessage(error, tTerminal))
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
