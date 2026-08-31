"use client"

/**
 * Placement candidates for a picker, with a verdict on each.
 *
 * A lighter assembly of the same pure builders `useDeviceRows` uses. A picker
 * lives inside another surface's sidebar and must not pay for a console: this
 * hook reads only the two cheap sources (the Dexie `pairedDevices` rows and
 * the remote-host store) and never polls, never calls the host, and never
 * touches the sandbox registry. The derivation is identical because it is the
 * same `buildDeviceRows`.
 *
 * What it returns that the old per-picker filters did not: **ineligible
 * candidates, with a reason.** The workflow editor used to filter its Select
 * down to hosts carrying `workflow.execution` and silently drop the rest, so
 * an offline host, an unprobed one, and a phone were equally invisible —
 * absent — and "why can this not run there?" had no answer anywhere.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useShallow } from "zustand/react/shallow"

import { APP_VERSION } from "@/lib/app-version"
import { buildDeviceRows } from "@/lib/devices/build-device-rows"
import { buildDeviceOptions, type DeviceOption } from "@/lib/devices/placement-directory"
import type { RemoteHostInput } from "@/lib/devices/types"
import type { PlacementRequirement } from "@/lib/placement/types"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { detectLocalCapabilities } from "@/lib/platform/capabilities"
import { detectPlatform } from "@/lib/platform/detect"
import { getFriendlyDeviceLabel } from "@/lib/device/device-identity"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

export interface UseDeviceOptionsInput {
  requirements: readonly PlacementRequirement[]
  /** Restrict the list — a workflow target is never a phone, for instance. */
  kinds?: readonly DeviceOption["row"]["kind"][]
  /**
   * Clock the verdicts are judged against. Defaults to a snapshot taken when
   * the picker mounted — a Select's list must not reshuffle or start reporting
   * `offline` while it is open, and a picker is short-lived enough that a
   * mount-time snapshot is the right granularity.
   */
  now?: number
}

export function useDeviceOptions(input: UseDeviceOptionsInput): DeviceOption[] {
  const pairedDevices = useLiveQuery(() => listPairedDevices(), [], [])
  const { hosts, activeHostId } = useRemoteHostStore(
    useShallow((state) => ({ hosts: state.hosts, activeHostId: state.activeHostId }))
  )
  const { requirements, kinds } = input
  const [mountedAt] = useState(() => Date.now())
  const now = input.now ?? mountedAt

  return useMemo(() => {
    const rows = buildDeviceRows({
      local: {
        ref: "local",
        label: getFriendlyDeviceLabel(),
        platform: detectPlatform(),
        appVersion: APP_VERSION,
        capabilities: detectLocalCapabilities(),
        // Neither is probed here — a picker must not pay for a health check,
        // and a sandbox tier is not something any picker asks about today.
        microvmAvailable: false,
        osSandboxAvailable: false,
      },
      pairedDevices: pairedDevices ?? [],
      remoteHosts: hosts as unknown as readonly RemoteHostInput[],
      // A picker asks "where could this run", and an SSH host is never an
      // answer to that: `placementKindFor` returns null for it. Listing them
      // here would only add permanently-disabled rows to every Select.
      sshHosts: [],
      workers: [],
      sandboxConnections: [],
      activeHostId,
      // A picker asks where work could run, never how a device is reached, so
      // it does not render the WAN facet at all. Saying "not managed here" is
      // the truthful answer for this surface, and it keeps a Select from
      // subscribing to the WebRTC master switch to answer a question it never
      // asks.
      holdsWanConnections: false,
      now,
    })
    const scoped = kinds ? rows.filter((row) => kinds.includes(row.kind)) : rows
    return buildDeviceOptions(scoped, requirements, now)
  }, [pairedDevices, hosts, activeHostId, requirements, kinds, now])
}
