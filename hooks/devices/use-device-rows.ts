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

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
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
import { isTauri, transport } from "@/lib/tauri"
import {
  getWanWakeOverrides,
  getWanWakeOverridesServerSnapshot,
  subscribeWanWakeOverrides,
} from "@/lib/signaling/wan-wake-overrides"
import {
  getSshProbes,
  getSshProbesServerSnapshot,
  readSshProbe,
  sshProbeTarget,
  subscribeSshProbes,
} from "@/lib/devices/ssh-probe-store"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import { useSandboxRuntimeAvailability } from "@/hooks/sandbox/use-sandbox-runtime-availability"
import { projectSandboxConnectionCapabilities } from "@/lib/sandbox/runtime-availability"

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
  const runtimeAvailability = useSandboxRuntimeAvailability()

  const { hosts, activeHostId } = useRemoteHostStore(
    useShallow((state) => ({ hosts: state.hosts, activeHostId: state.activeHostId }))
  )
  /**
   * Saved SSH hosts come from settings, not from a device registry: nothing
   * enrolls them and nothing pings them. They are listed so the console is the
   * one place every remote machine appears, and their rows say plainly that a
   * shell is all they offer.
   */
  const sshHosts = useSettingsStore(selectSavedSshHosts)
  /**
   * What an explicit Test connection last found, for the hosts above.
   *
   * A module-level map rather than a Dexie row on purpose (see
   * `lib/devices/ssh-probe-store.ts`), so this is how the console subscribes
   * to it, the same way it subscribes to the WAN wake overrides.
   */
  const sshProbes = useSyncExternalStore(
    subscribeSshProbes,
    getSshProbes,
    getSshProbesServerSnapshot
  )
  /**
   * The WebRTC master switch. Absent means on, matching
   * `buildSignalingConfigPatch`, so the console and the hub agree about a
   * settings row that predates the toggle.
   */
  const wanEnabled = useSettingsStore((state) => state.settings?.webrtcEnabled ?? true)
  /**
   * Devices the owner woke this session. A plain module-level set rather than a
   * Dexie row on purpose (see `lib/signaling/wan-wake-overrides.ts`), so this is
   * how the console subscribes to it.
   */
  const wokenWanDeviceIds = useSyncExternalStore(
    subscribeWanWakeOverrides,
    getWanWakeOverrides,
    getWanWakeOverridesServerSnapshot
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

  /**
   * The probe answers that still describe the hosts they name.
   *
   * Two filters, both of which need something the row builder is pure of. An
   * answer past its TTL is a fact about a moment nobody has re-checked, and an
   * answer recorded before the host's address changed describes a different
   * machine. Either one rendered as presence would be the console claiming
   * knowledge it does not have, which is exactly what `unknown` was protecting.
   *
   * Recomputed on the same `now` the rows are judged against, so a result ages
   * out of the list on the poll rather than only when something else changes.
   */
  const liveSshProbes = useMemo(() => {
    const live = new Map<string, { online: boolean; at: number }>()
    for (const profile of sshHosts ?? []) {
      const record = readSshProbe(profile.id, sshProbeTarget(profile), now)
      if (record) live.set(profile.id, { online: record.online, at: record.at })
    }
    return live
  }, [sshHosts, sshProbes, now])

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
        microvmAvailable: runtimeAvailability.microvm.available,
        osSandboxAvailable: runtimeAvailability.os.available,
      },
      pairedDevices: pairedDevices ?? [],
      hostDevices: hostDevices ?? undefined,
      remoteHosts: hosts as unknown as readonly RemoteHostInput[],
      sshHosts: sshHosts ?? [],
      /**
       * Expiry and re-targeting are resolved here rather than in the builder.
       * `readSshProbe` needs the clock and the host's current address, and the
       * builder is pure of both, so what crosses into it is already only the
       * answers that still describe the rows they name.
       */
      sshProbes: liveSshProbes,
      workers,
      presence: readPresence(deviceIds),
      sandboxConnections: connections.map((connection) => ({
        ...connection,
        capabilities: projectSandboxConnectionCapabilities(connection, isTauri()),
      })),
      activeHostId,
      // Only the Tauri desktop runs the signaling hub, so only it can say
      // whether a WAN connection is held, or start one.
      holdsWanConnections: isTauri(),
      wanEnabled,
      wokenWanDeviceIds,
      ownerNames,
      ...(hostPersonUserId ? { hostPersonUserId } : {}),
      now,
    })
  }, [
    pairedDevices,
    hostDevices,
    hosts,
    sshHosts,
    liveSshProbes,
    workers,
    connections,
    activeHostId,
    wanEnabled,
    wokenWanDeviceIds,
    ownerNames,
    hostPersonUserId,
    runtimeAvailability.microvm.available,
    runtimeAvailability.os.available,
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
