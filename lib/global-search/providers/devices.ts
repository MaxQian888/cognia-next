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
import { pairedDeviceRef, remoteHostRef, sshHostRef } from "@/lib/devices/build-device-rows"
import type { DeviceKind, RemoteHostInput, SshHostInput } from "@/lib/devices/types"
import { readSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
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
  /**
   * Saved SSH hosts. A third cheap identity source, and the one a user is most
   * likely to reach for by name: "prod-web-01" is a thing people type.
   */
  listSshHosts: () => readonly SshHostInput[]
}

/**
 * The real wiring, kept as a named export so a test can reach it.
 *
 * Every case in this module's suite injects its own `deps`, so nothing here is
 * exercised by them: a wrong read would return `[]` forever and the suite would
 * stay green. That is exactly how the SSH list shipped broken once, which is
 * why the settings path now lives in `lib/terminal/saved-ssh-hosts` with its
 * own tests, and why `listRemoteHosts` is asserted directly below.
 */
export const DEFAULT_DEVICES_PROVIDER_DEPS: DevicesProviderDeps = {
  listPairedDevices,
  listRemoteHosts: () =>
    useRemoteHostStore.getState().hosts as unknown as readonly RemoteHostInput[],
  listSshHosts: readSavedSshHosts,
}

/**
 * One source's failure must not blank the other two.
 *
 * A provider's `load` is cached (`list-provider.ts`), so a rejection does not
 * just drop this keystroke: devices vanish from the palette until the TTL
 * expires. Each source is therefore isolated, including the two synchronous
 * store reads, which can throw before their store has hydrated.
 *
 * The failure is logged rather than swallowed. An empty list is a legitimate
 * answer here, so a silent `[]` makes "you have no SSH hosts" and "the settings
 * store threw" the same result on screen and leaves nothing anywhere to tell
 * them apart. That is exactly how the wrong settings path went unnoticed.
 */
async function readSource<T>(
  name: string,
  read: () => readonly T[] | PromiseLike<readonly T[]>
): Promise<readonly T[]> {
  try {
    return await read()
  } catch (error) {
    console.warn(`global-search/devices: ${name} failed; listing none from it`, error)
    return []
  }
}

export async function loadDeviceSearchRows(
  deps: DevicesProviderDeps = DEFAULT_DEVICES_PROVIDER_DEPS
): Promise<DeviceSearchRow[]> {
  const [devices, hosts, sshHosts] = await Promise.all([
    readSource("listPairedDevices", () => deps.listPairedDevices()),
    readSource("listRemoteHosts", () => deps.listRemoteHosts()),
    readSource("listSshHosts", () => deps.listSshHosts()),
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
    ...sshHosts.map((profile) => ({
      ref: sshHostRef(profile),
      kind: "ssh-host" as const,
      label: profile.name || `${profile.username}@${profile.host}`,
      // The address, because two saved profiles often differ only by host.
      detail: `${profile.username}@${profile.host}:${profile.port}`,
    })),
  ]
}

export function createDevicesProvider(deps: DevicesProviderDeps = DEFAULT_DEVICES_PROVIDER_DEPS) {
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
