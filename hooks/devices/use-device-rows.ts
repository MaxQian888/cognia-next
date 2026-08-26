"use client"

/**
 * Live device rows for the console.
 *
 * The only place the console talks to Dexie, the host, the remote-host store,
 * and the sandbox registry; everything downstream consumes the pure
 * `DeviceRow[]` that `buildDeviceRows` returns. That split is what makes the
 * derivation testable without a paired phone.
 *
 * Two host reads are new here. `companion_list_devices` has existed since the
 * SecurityStore landed — its doc comment calls it "the Device Center's read
 * side" — with no TypeScript caller, so a device suspended through the
 * `cognia-server devices` CLI or the Owner API was invisible to the desktop.
 * `companion_list_workers` was already used by the fleet card and is reused
 * rather than re-fetched differently here.
 *
 * Both degrade rather than fail: off-Tauri, or on a host that refuses, the
 * rows fall back to the Dexie mirror and {@link UseDeviceRowsResult.hostUnreachable}
 * says so, because a console that renders nothing is worse than one that
 * renders the mirror and admits what it is.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useShallow } from "zustand/react/shallow"

import { APP_VERSION } from "@/lib/app-version"
import { buildDeviceRows, summarizeDeviceRows } from "@/lib/devices/build-device-rows"
import type {
  DevicePresenceSummary,
  DeviceRow,
  HostDeviceSummaryInput,
  RemoteHostInput,
  WorkerInput,
} from "@/lib/devices/types"
import { devicePresence } from "@/lib/companion/device-presence-registry"
import { listExecutionWorkers } from "@/lib/fleet/execution-workers"
import { listUsers } from "@/lib/db/identity"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { readHostPerson } from "@/lib/identity/host-person"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { detectLocalCapabilities } from "@/lib/platform/capabilities"
import { detectPlatform } from "@/lib/platform/detect"
import { getFriendlyDeviceLabel } from "@/lib/device/device-identity"
import { getMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { isTauri, transport } from "@/lib/tauri"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import { useSandboxHealth } from "@/hooks/sandbox/use-sandbox-health"

/**
 * How often live presence and the host snapshot are re-read.
 *
 * The presence registry is a plain in-process map with no subscription, and a
 * console is a foreground surface, so polling is the honest mechanism. Five
 * seconds is well inside the 90 s liveness TTL, so a device never sits visibly
 * stale for a meaningful fraction of the window it is judged by.
 */
export const DEVICE_POLL_INTERVAL_MS = 5_000

export interface UseDeviceRowsResult {
  rows: DeviceRow[]
  summary: { total: number; online: number; needsAttention: number }
  /** True until the first host read settles, either way. */
  loading: boolean
  /**
   * The host could not be asked, so lifecycle state and raw grant capabilities
   * come from the Dexie mirror. Surfaced, never swallowed.
   */
  hostUnreachable: boolean
  refresh: () => Promise<void>
}

async function readHostDevices(): Promise<Map<string, HostDeviceSummaryInput> | null> {
  if (!isTauri()) return null
  try {
    const rows = await transport.call<HostDeviceSummaryInput[]>("companion_list_devices")
    if (!Array.isArray(rows)) return null
    return new Map(rows.map((row) => [row.deviceId, row]))
  } catch {
    return null
  }
}

/**
 * `usr_…` → display name, from the ADR-0149 identity projection.
 *
 * Only the ids the host actually reported are looked up: the projection is a
 * client cache of the collaboration plane, and reading every person on every
 * poll to label a handful of devices would be the wrong trade.
 */
async function readOwnerNames(
  hostDevices: Map<string, HostDeviceSummaryInput> | null
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      [...(hostDevices?.values() ?? [])]
        .map((device) => device.userId)
        .filter((id): id is string => Boolean(id))
    ),
  ]
  if (ids.length === 0) return new Map()
  try {
    const users = await listUsers(ids)
    return new Map(users.map((user) => [user.id, user.displayName]))
  } catch {
    // The console falls back to the raw id, which still answers "whose?".
    return new Map()
  }
}

/**
 * The person signed in on THIS host — ADR-0149 §5 step two.
 *
 * Read from the host rather than from the renderer's own sign-in state,
 * because `host_bindings.user_id` is the value the capability query actually
 * joins against. Asking the renderer would risk the console explaining a
 * decision the host is not making.
 *
 * `undefined` off the desktop and whenever nobody has signed in, which is the
 * common state and means ownership decides nothing.
 */
async function readHostPersonId(): Promise<string | undefined> {
  try {
    const person = await readHostPerson(getActiveAccountId())
    return person?.userId ?? undefined
  } catch {
    return undefined
  }
}

async function readWorkers(): Promise<WorkerInput[]> {
  try {
    return await listExecutionWorkers()
  } catch {
    // A host with no worker plane answers with an error rather than an empty
    // list. That is "no workers", not a console failure.
    return []
  }
}

function readPresence(deviceIds: readonly string[]): Map<string, DevicePresenceSummary> {
  const map = new Map<string, DevicePresenceSummary>()
  for (const deviceId of deviceIds) {
    const presence = devicePresence(deviceId)
    if (!presence) continue
    map.set(deviceId, {
      eventPlane: presence.eventPlane,
      attention: presence.attention,
      streams: presence.streams,
    })
  }
  return map
}

export function useDeviceRows(): UseDeviceRowsResult {
  const pairedDevices = useLiveQuery(() => listPairedDevices(), [], [])
  const { connections } = useSandboxConnections()
  const { health } = useSandboxHealth()

  const { hosts, activeHostId } = useRemoteHostStore(
    useShallow((state) => ({ hosts: state.hosts, activeHostId: state.activeHostId }))
  )

  const [hostDevices, setHostDevices] = useState<Map<string, HostDeviceSummaryInput> | null>(null)
  const [workers, setWorkers] = useState<WorkerInput[]>([])
  const [ownerNames, setOwnerNames] = useState<Map<string, string>>(() => new Map())
  const [hostPersonUserId, setHostPersonUserId] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  /**
   * The clock the rows are judged against, advanced by the poll rather than
   * read inside the memo.
   *
   * Reachability is a function of `now - lastSeenAt`, so the clock is an input
   * to the derivation and has to move for a row to go stale on screen. Reading
   * `Date.now()` inside the memo would make it impure — and would also not
   * re-run when nothing else changed, so a device would sit "online" forever.
   */
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    const [devices, workerRows, hostPerson] = await Promise.all([
      readHostDevices(),
      readWorkers(),
      readHostPersonId(),
    ])
    setHostDevices(devices)
    setWorkers(workerRows)
    setHostPersonUserId(hostPerson)
    setOwnerNames(await readOwnerNames(devices))
    setLoading(false)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = () => {
      void refresh().catch(() => {
        if (!cancelled) setLoading(false)
      })
    }
    run()
    const timer = setInterval(run, DEVICE_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  const rows = useMemo(() => {
    // Presence lives in a plain in-process map with no subscription, so it is
    // re-read here on every `now` advance — the poll is the subscription.
    const deviceIds = (pairedDevices ?? []).map((row) => row.deviceId)
    return buildDeviceRows({
      local: {
        ref: "local",
        label: getFriendlyDeviceLabel(),
        platform: detectPlatform(),
        appVersion: APP_VERSION,
        capabilities: detectLocalCapabilities(),
        microvmAvailable: getMicrovmExec() !== null,
        osSandboxAvailable: health.available,
      },
      pairedDevices: pairedDevices ?? [],
      hostDevices: hostDevices ?? undefined,
      remoteHosts: hosts as unknown as readonly RemoteHostInput[],
      workers,
      presence: readPresence(deviceIds),
      sandboxConnections: connections,
      activeHostId,
      ownerNames,
      ...(hostPersonUserId ? { hostPersonUserId } : {}),
      now,
    })
  }, [
    pairedDevices,
    hostDevices,
    hosts,
    workers,
    connections,
    activeHostId,
    ownerNames,
    hostPersonUserId,
    health.available,
    now,
  ])

  return {
    rows,
    summary: useMemo(() => summarizeDeviceRows(rows), [rows]),
    loading,
    hostUnreachable: isTauri() && hostDevices === null && !loading,
    refresh,
  }
}
