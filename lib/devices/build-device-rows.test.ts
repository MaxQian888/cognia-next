import {
  buildDeviceRows,
  deriveReachability,
  dispatchTargetRef,
  pairedDeviceRef,
  remoteHostRef,
  summarizeDeviceRows,
  workerRef,
} from "./build-device-rows"
import { RECENTLY_ACTIVE_WINDOW_MS } from "@/lib/companion/device-presence-registry"
import { DEFAULT_LIVENESS_TTL_MS } from "@/lib/placement/liveness"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type {
  BuildDeviceRowsInput,
  DeviceRow,
  HostDeviceSummaryInput,
  LocalDeviceInput,
  RemoteHostInput,
  WorkerInput,
} from "./types"

const NOW = 10_000_000

const LOCAL: LocalDeviceInput = {
  ref: "local",
  label: "This Mac",
  platform: "tauri",
  appVersion: "1.2.3",
  capabilities: ["shell", "pty", "keyring"],
  microvmAvailable: false,
  osSandboxAvailable: true,
}

function phone(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Max's iPhone",
    platform: "ios",
    pubkey: "k",
    pairedAt: NOW - 86_400_000,
    lastSeenAt: NOW - 1_000,
    allowRemoteTerminal: false,
    appVersion: "1.2.3",
    ...overrides,
  }
}

function manifestV2(id: string): HostFeatureManifest {
  return {
    schemaVersion: 2,
    hostBuildId: "2.0.0",
    platform: "tauri",
    generatedAt: NOW,
    features: { "workflow.execution": { version: 1, operations: ["run"] } },
    limits: {
      rpcJsonBodyBytes: 1,
      skillMaxResources: 1,
      skillMaxResourceBytes: 1,
      skillUploadChunkBytes: 1,
      mcpRequestBodyBytes: 1,
      maxConcurrentProxyCalls: 1,
    },
    hostIdentity: { id, kind: "desktop" },
    protocol: { min: 1, max: 2 },
    operations: [],
    deviceGrants: [],
  }
}

function host(overrides: Partial<RemoteHostInput> = {}): RemoteHostInput {
  return {
    id: "h1",
    label: "Build box",
    connectionState: "ready",
    addedAt: NOW - 100_000,
    lastConnectedAt: NOW - 500,
    config: { baseUrl: "https://build.local", serverVersion: "2.0.0" },
    ...overrides,
  }
}

function worker(overrides: Partial<WorkerInput> = {}): WorkerInput {
  return {
    deviceId: "w1",
    hostRef: "worker-ref-1",
    displayName: "CI runner",
    role: "worker",
    status: "active",
    createdAt: NOW - 200_000,
    updatedAt: NOW - 400,
    capabilities: ["agent.run"],
    ...overrides,
  }
}

function input(overrides: Partial<BuildDeviceRowsInput> = {}): BuildDeviceRowsInput {
  return {
    local: LOCAL,
    pairedDevices: [],
    remoteHosts: [],
    workers: [],
    sandboxConnections: [],
    activeHostId: null,
    now: NOW,
    ...overrides,
  }
}

function find(rows: DeviceRow[], ref: string): DeviceRow {
  const row = rows.find((candidate) => candidate.ref === ref)
  if (!row) throw new Error(`no row ${ref} in ${rows.map((r) => r.ref).join(", ")}`)
  return row
}

describe("refs", () => {
  it("namespaces each kind so a phone and a host can never collide", () => {
    expect(pairedDeviceRef("abc")).toBe("device:abc")
    expect(remoteHostRef(host({ featureManifest: undefined }))).toBe("host:h1")
  })

  /**
   * `runOn: { mode: "pinned", ref }` already stores the manifest's host
   * identity, so the console must address a probed host the same way or a pin
   * set here would not match the one the resolver reads.
   */
  it("prefers a host's published identity over the local store id", () => {
    expect(remoteHostRef(host({ featureManifest: manifestV2("published-id") }))).toBe(
      "published-id"
    )
  })

  it("addresses a worker by hostRef, the way remote-worker-runtime pins it", () => {
    expect(workerRef(worker())).toBe("worker-ref-1")
  })
})

describe("dispatchTargetRef", () => {
  /**
   * `HostDispatchJobRow.targetRef` is documented as being in the target's own
   * vocabulary — a raw `deviceId`, a `hostRef`, a remote-host id — while the
   * console namespaces its refs. Querying the queue with the namespaced ref
   * returns nothing, which reads as "no work has ever been sent here".
   */
  it("uses each kind's own addressing, not the console ref", () => {
    const rows = buildDeviceRows(
      input({ pairedDevices: [phone()], remoteHosts: [host()], workers: [worker()] })
    )
    expect(dispatchTargetRef(find(rows, "device:d1"))).toBe("d1")
    expect(dispatchTargetRef(find(rows, "host:h1"))).toBe("h1")
    expect(dispatchTargetRef(find(rows, "worker-ref-1"))).toBe("worker-ref-1")
  })

  it("has no answer for this machine, which the queue never addresses", () => {
    const rows = buildDeviceRows(input())
    expect(dispatchTargetRef(find(rows, "local"))).toBeUndefined()
  })
})

describe("deriveReachability", () => {
  it("trusts a ready event stream outright", () => {
    const ancient = { online: true, lastSeenAt: 1, source: "request" as const }
    expect(deriveReachability(ancient, true, NOW)).toBe("online")
  })

  it("trusts a fresh timestamp inside the shared liveness TTL", () => {
    const fresh = {
      online: true,
      lastSeenAt: NOW - DEFAULT_LIVENESS_TTL_MS + 1_000,
      source: "request" as const,
    }
    expect(deriveReachability(fresh, false, NOW)).toBe("online")
  })

  it("degrades past the TTL to recently-active before offline", () => {
    const lapsed = {
      online: true,
      lastSeenAt: NOW - DEFAULT_LIVENESS_TTL_MS - 1_000,
      source: "request" as const,
    }
    expect(deriveReachability(lapsed, false, NOW)).toBe("recently-active")

    const cold = {
      online: true,
      lastSeenAt: NOW - RECENTLY_ACTIVE_WINDOW_MS - 1,
      source: "request" as const,
    }
    expect(deriveReachability(cold, false, NOW)).toBe("offline")
  })

  it("never reads never-seen as offline", () => {
    expect(
      deriveReachability({ online: false, lastSeenAt: 0, source: "manifest" }, false, NOW)
    ).toBe("unknown")
  })
})

describe("admin state precedence", () => {
  const hostDevice = (status: string): ReadonlyMap<string, HostDeviceSummaryInput> =>
    new Map([
      [
        "d1",
        {
          deviceId: "d1",
          displayName: "Max's iPhone",
          role: "member",
          status,
          createdAt: NOW,
          updatedAt: NOW,
          capabilities: [],
        },
      ],
    ])

  /**
   * The gap this closes: a device suspended through the `cognia-server
   * devices` CLI or the Owner API left the Dexie mirror untouched, so the old
   * card read "active" while every call from that device was being refused.
   */
  it("lets the host overrule the local mirror and flags the disagreement", () => {
    const rows = buildDeviceRows(
      input({ pairedDevices: [phone()], hostDevices: hostDevice("suspended") })
    )
    expect(find(rows, "device:d1")).toMatchObject({
      adminState: "paused",
      adminStateConflict: true,
      role: "member",
    })
  })

  it("does not flag a conflict when the two agree", () => {
    const rows = buildDeviceRows(
      input({ pairedDevices: [phone({ pausedAt: NOW })], hostDevices: hostDevice("suspended") })
    )
    expect(find(rows, "device:d1").adminStateConflict).toBeUndefined()
  })

  it("falls back to the mirror when the host could not be asked at all", () => {
    const rows = buildDeviceRows(input({ pairedDevices: [phone({ revokedAt: NOW })] }))
    expect(find(rows, "device:d1")).toMatchObject({
      adminState: "revoked",
      adminStateConflict: undefined,
    })
  })

  it("denies every grant on a revoked device", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [
          phone({ revokedAt: NOW, allowRemoteControl: true, allowRemoteTerminal: true }),
        ],
      })
    )
    expect(find(rows, "device:d1").grants.every((grant) => grant.state === "denied")).toBe(true)
  })
})

describe("remote host liveness", () => {
  /**
   * The store only reports `ready` after authentication and both capability
   * probes succeed, so the transport is demonstrably open. Judging that
   * against `lastConnectedAt` would report a freshly-activated host as offline
   * while it is answering calls.
   */
  it("treats a ready host as present even before it records a connection time", () => {
    const rows = buildDeviceRows(
      input({
        remoteHosts: [host({ connectionState: "ready", lastConnectedAt: undefined })],
      })
    )
    const row = find(rows, "host:h1")
    expect(row.liveness.source).toBe("socket")
    expect(row.reachability).toBe("online")
  })

  it("ages a host that is not ready against its last evidence", () => {
    const rows = buildDeviceRows(
      input({
        // Well past the recently-active window, but still a positive instant:
        // NOW is small in these fixtures, so a day's offset would go negative
        // and read as "never seen" instead of "stale".
        remoteHosts: [host({ connectionState: "degraded", lastConnectedAt: NOW - 600_000 })],
      })
    )
    const row = find(rows, "host:h1")
    expect(row.liveness.source).toBe("manifest")
    expect(row.reachability).toBe("offline")
  })

  it("reports a host that was never reached as unknown, not offline", () => {
    const rows = buildDeviceRows(
      input({
        remoteHosts: [host({ connectionState: "disconnected", lastConnectedAt: undefined })],
      })
    )
    expect(find(rows, "host:h1")).toMatchObject({
      reachability: "unknown",
      adminState: "unknown",
    })
  })
})

describe("row composition", () => {
  it("marks the local machine as self and always online", () => {
    const rows = buildDeviceRows(input())
    expect(rows[0]).toMatchObject({ ref: "local", isSelf: true, reachability: "online" })
  })

  it("flags a phone that has never reported capabilities", () => {
    const rows = buildDeviceRows(input({ pairedDevices: [phone()] }))
    const row = find(rows, "device:d1")
    expect(row.capabilityReportMissing).toBe(true)
    expect(row.capabilities.some((cell) => cell.state === "absent")).toBe(false)
  })

  it("carries a reported capability set through to the matrix", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [phone({ capabilities: ["camera"], capabilitiesReportedAt: NOW - 10 })],
      })
    )
    const row = find(rows, "device:d1")
    expect(row.capabilityReportMissing).toBe(false)
    expect(row.capabilities.find((cell) => cell.id === "camera")?.state).toBe("reported")
    expect(row.capabilities.find((cell) => cell.id === "biometric")?.state).toBe("absent")
  })

  it("gives a host both a platform matrix and a feature matrix", () => {
    const rows = buildDeviceRows(
      input({
        remoteHosts: [
          host({
            capabilities: ["headless"],
            capabilitiesAt: NOW - 5,
            featureManifest: manifestV2("published-id"),
            featureManifestAt: NOW - 5,
          }),
        ],
      })
    )
    const row = find(rows, "published-id")
    expect(row.capabilities.some((cell) => cell.group === "platform")).toBe(true)
    expect(row.capabilities.find((cell) => cell.id === "workflow.execution")).toMatchObject({
      group: "host-execution",
      state: "reported",
    })
    expect(row.placement.provides).toContainEqual({
      dimension: "host-feature",
      value: "workflow.execution",
    })
  })

  it("gives a worker no platform matrix, because its ids are a different vocabulary", () => {
    const rows = buildDeviceRows(input({ workers: [worker()] }))
    const row = find(rows, "worker-ref-1")
    expect(row.capabilities).toEqual([])
    expect(row.placement.provides).toEqual([{ dimension: "agent", value: "agent.run" }])
  })

  it("never leaks this machine's sandbox connections onto another row", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [phone()],
        remoteHosts: [host()],
        workers: [worker()],
        sandboxConnections: [{ id: "c1" } as never],
      })
    )
    for (const row of rows) {
      if (row.isSelf) expect(row.runtime.sandbox.connections).toHaveLength(1)
      else expect(row.runtime.sandbox.connections).toEqual([])
    }
  })
})

describe("ordering and summary", () => {
  it("puts this machine first, then live before dormant, then stable by ref", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [
          phone({ deviceId: "cold", label: "Old tablet", lastSeenAt: NOW - 86_400_000 }),
          phone({ deviceId: "warm", label: "Phone", lastSeenAt: NOW - 500 }),
        ],
      })
    )
    expect(rows.map((row) => row.ref)).toEqual(["local", "device:warm", "device:cold"])
  })

  it("counts what the header shows", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [phone({ deviceId: "gone", revokedAt: NOW })],
        remoteHosts: [host({ id: "h9", connectionState: "degraded", lastConnectedAt: NOW - 10 })],
      })
    )
    expect(summarizeDeviceRows(rows)).toEqual({ total: 3, online: 1, needsAttention: 2 })
  })
})
