/**
 * Devices (ADR-0129): paired phones, remote hosts and execution workers,
 * every one of them opening the `/devices` console.
 *
 * Identity only. A search provider runs on every keystroke, so it reads the
 * two cheap identity sources — the Dexie `pairedDevices` rows and the
 * remote-host store snapshot — rather than assembling full console rows, which
 * would drag in a host RPC, the sandbox registry and a liveness clock for a
 * list of names.
 *
 * The retired surfaces are covered by the rail entry's `aliasKey`, not here:
 * typing "paired devices" has to land somewhere even when no device matches.
 */

import { SmartphoneIcon } from "lucide-react"

import { listPairedDevices } from "@/lib/db/paired-devices"
import { pairedDeviceRef, remoteHostRef } from "@/lib/devices/build-device-rows"
import type { DeviceKind, RemoteHostInput } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { createListProvider } from "./list-provider"

export const DEVICES_PROVIDER_ID = "builtin.devices"

/** The identity subset the palette needs. Never the full console row. */
export interface DeviceSearchRow {
  ref: string
  kind: DeviceKind
  label: string
  /** Platform for a phone, base URL for a host — the disambiguating detail. */
  detail?: string
  timestamp?: number
}

export interface DevicesProviderDeps {
  listPairedDevices: typeof listPairedDevices
  listRemoteHosts: () => readonly RemoteHostInput[]
}

const defaultDeps: DevicesProviderDeps = {
  listPairedDevices,
  listRemoteHosts: () =>
    useRemoteHostStore.getState().hosts as unknown as readonly RemoteHostInput[],
}

export async function loadDeviceSearchRows(
  deps: DevicesProviderDeps = defaultDeps
): Promise<DeviceSearchRow[]> {
  const [devices, hosts] = await Promise.all([
    deps.listPairedDevices().catch(() => []),
    Promise.resolve(deps.listRemoteHosts()),
  ])

  return [
    ...devices.map((row) => ({
      ref: pairedDeviceRef(row.deviceId),
      kind: "paired-device" as const,
      label: row.label,
      detail: row.platform,
      timestamp: row.lastSeenAt,
    })),
    ...hosts.map((host) => ({
      ref: remoteHostRef(host),
      kind: "remote-host" as const,
      label: host.label,
      detail: host.config.baseUrl,
      timestamp: host.lastConnectedAt ?? host.addedAt,
    })),
  ]
}

export function createDevicesProvider(deps: DevicesProviderDeps = defaultDeps) {
  return createListProvider<DeviceSearchRow>({
    id: DEVICES_PROVIDER_ID,
    kind: "device",
    load: () => loadDeviceSearchRows(deps),
    getTitle: (row) => row.label,
    getSecondary: (row) => row.detail,
    // The ref is searchable so a deep link pasted from a log resolves to the
    // device it names, which is otherwise a manual hunt through the list.
    getKeywords: (row) => [row.ref, row.kind],
    getTimestamp: (row) => row.timestamp,
    toItem: ({ row, match }, ctx) => ({
      id: `device:${row.ref}`,
      kind: "device" as const,
      title: row.label,
      titlePositions: match.positions,
      subtitle: row.detail,
      meta: ctx.t(`devices.kind.${row.kind}`),
      icon: { lucide: SmartphoneIcon },
      score: match.score,
      timestamp: row.timestamp,
      action: { type: "navigate", href: `/devices?device=${encodeURIComponent(row.ref)}` },
    }),
  })
}

export const devicesProvider = createDevicesProvider()
