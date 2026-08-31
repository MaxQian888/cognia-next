import {
  buildDeviceRows,
  buildDeviceWan,
  deriveReachability,
  dispatchTargetRef,
  pairedDeviceRef,
  remoteHostRef,
  rowNeedsAttention,
  summarizeDeviceRows,
  workerRef,
} from "./build-device-rows"
import { RECENTLY_ACTIVE_WINDOW_MS } from "@/lib/companion/device-presence-registry"
import { DEFAULT_LIVENESS_TTL_MS } from "@/lib/placement/liveness"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { selectSignalingDevices } from "@/lib/signaling/desktop-controller"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type {
  BuildDeviceRowsInput,
  DeviceRow,
  HostDeviceSummaryInput,
  LocalDeviceInput,
  RemoteHostInput,
  SshHostInput,
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
    sshHosts: [],
    workers: [],
    sandboxConnections: [],
    activeHostId: null,
    holdsWanConnections: true,
    wanEnabled: true,
    now: NOW,
    ...overrides,
  }
}

/**
 * A phone provisioned for WebRTC. The bare {@link phone} fixture deliberately
 * is not, because most rows in this repo's history predate ADR-0021.
 */
function wanPhone(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return phone({
    rendezvousId: "r1",
    signalingKeyRef: "kr:d1",
    signalingRoomDescriptor: {
      v: 2,
      roomId: "r1",
      roomNonce: "nonce",
      desktopSigningKey: "desktop-key",
      mobileSigningKey: "mobile-key",
      notAfter: NOW + 1_000_000,
    },
    ...overrides,
  })
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

  /**
   * The header badge and the rail dot both call `rowNeedsAttention`. They used
   * to carry their own copy of the predicate, which is how a console ends up
   * announcing "2 need attention" over a list with nothing marked.
   */
  it("counts exactly the rows the shared predicate marks", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [phone({ deviceId: "gone", revokedAt: NOW })],
        remoteHosts: [host({ id: "h9", connectionState: "degraded", lastConnectedAt: NOW - 10 })],
      })
    )
    expect(rows.filter(rowNeedsAttention)).toHaveLength(summarizeDeviceRows(rows).needsAttention)
  })

  it("does not count an offline device as needing attention", () => {
    // A phone in a pocket is offline and that is its expected state. Counting
    // it would light the badge permanently and make it unreadable.
    const rows = buildDeviceRows(
      input({
        pairedDevices: [
          phone({ deviceId: "idle", lastSeenAt: NOW - DEFAULT_LIVENESS_TTL_MS * 10 }),
        ],
      })
    )
    const idle = rows.find((row) => row.deviceId === "idle")
    expect(idle?.reachability).toBe("offline")
    expect(rowNeedsAttention(idle as DeviceRow)).toBe(false)
    expect(summarizeDeviceRows(rows).needsAttention).toBe(0)
  })

  it("marks a host whose lifecycle the mirror disagrees about", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [phone({ deviceId: "d1" })],
        hostDevices: new Map<string, HostDeviceSummaryInput>([
          ["d1", { deviceId: "d1", status: "suspended", role: "member", capabilities: [] }],
        ]),
      })
    )
    const row = rows.find((candidate) => candidate.deviceId === "d1") as DeviceRow
    expect(row.adminStateConflict).toBe(true)
    expect(rowNeedsAttention(row)).toBe(true)
  })
})

describe("device ownership (ADR-0149 §5, step one)", () => {
  function hostDevice(overrides: Record<string, unknown> = {}) {
    return new Map([
      [
        "device-a",
        {
          deviceId: "device-a",
          displayName: "Phone",
          role: "owner",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          capabilities: [] as readonly string[],
          ...overrides,
        },
      ],
    ])
  }

  function rowsWith(overrides: Partial<BuildDeviceRowsInput>) {
    return buildDeviceRows(
      input({ pairedDevices: [phone({ deviceId: "device-a" })], ...overrides })
    )
  }

  function pairedRow(rows: DeviceRow[]) {
    return rows.find((row) => row.deviceId === "device-a")
  }

  it("carries the owner the host reported", () => {
    const rows = rowsWith({ hostDevices: hostDevice({ userId: "usr_ada000000000000000000" }) })
    expect(pairedRow(rows)?.ownerUserId).toBe("usr_ada000000000000000000")
  })

  it("resolves a display name when the identity projection has one", () => {
    const rows = rowsWith({
      hostDevices: hostDevice({ userId: "usr_ada000000000000000000" }),
      ownerNames: new Map([["usr_ada000000000000000000", "Ada"]]),
    })
    expect(pairedRow(rows)?.ownerLabel).toBe("Ada")
  })

  it("keeps the id when no name is mirrored, rather than hiding the owner", () => {
    // "Unknown person" is a worse answer than an id you can search.
    const rows = rowsWith({ hostDevices: hostDevice({ userId: "usr_ada000000000000000000" }) })
    const row = pairedRow(rows)
    expect(row?.ownerUserId).toBe("usr_ada000000000000000000")
    expect(row?.ownerLabel).toBeUndefined()
  })

  it("omits ownership entirely for a device nobody has claimed", () => {
    const rows = rowsWith({ hostDevices: hostDevice() })
    const row = pairedRow(rows)
    expect(row).toBeDefined()
    expect("ownerUserId" in (row as object)).toBe(false)
    expect("ownerLabel" in (row as object)).toBe(false)
  })

  it("an unowned device is not a restricted device", () => {
    // With nobody signed in on this host, ownership decides nothing — the
    // grant rows must be identical whether or not the host reported an owner.
    // This is the state the two-release split protects, and it survives 4b.
    const owned = pairedRow(
      rowsWith({ hostDevices: hostDevice({ userId: "usr_ada000000000000000000" }) })
    )
    const unowned = pairedRow(rowsWith({ hostDevices: hostDevice() }))
    expect(owned?.grants).toEqual(unowned?.grants)
  })

  it("reports no owner when the host could not be asked at all", () => {
    const rows = rowsWith({ hostDevices: undefined })
    expect(pairedRow(rows)?.ownerUserId).toBeUndefined()
  })

  // ── ADR-0149 §5 step two: the grant decision follows the person ──────────

  const ADA = "usr_ada000000000000000000"
  const BOB = "usr_bob000000000000000000"

  it("suspends every grant on a device that belongs to somebody else", () => {
    const row = pairedRow(
      rowsWith({ hostDevices: hostDevice({ userId: BOB }), hostPersonUserId: ADA })
    )
    expect(row?.grants.every((grant) => grant.state === "suspended")).toBe(true)
    expect(row?.grants.every((grant) => grant.reasonKey === "ownerMismatch")).toBe(true)
  })

  it("leaves the signed-in person's own device alone", () => {
    const mine = pairedRow(
      rowsWith({ hostDevices: hostDevice({ userId: ADA }), hostPersonUserId: ADA })
    )
    const unbound = pairedRow(rowsWith({ hostDevices: hostDevice({ userId: ADA }) }))
    expect(mine?.grants).toEqual(unbound?.grants)
  })

  it("does not suspend a device the host never attributed", () => {
    // Every device that existed before the column did is in this state, and
    // denying them would be the fleet-wide lockout 4a existed to avoid.
    const row = pairedRow(rowsWith({ hostDevices: hostDevice(), hostPersonUserId: ADA }))
    expect(row?.grants.some((grant) => grant.state === "suspended")).toBe(false)
  })

  it("does not suspend anything when nobody is signed in on this host", () => {
    const row = pairedRow(rowsWith({ hostDevices: hostDevice({ userId: BOB }) }))
    expect(row?.grants.some((grant) => grant.state === "suspended")).toBe(false)
  })
})

describe("buildDeviceWan", () => {
  const DAY = 24 * 60 * 60 * 1000
  /**
   * A realistic wall clock. The module-wide `NOW` is 10,000 seconds past the
   * epoch, which is fine for a 90 s liveness TTL and useless against a 30-day
   * window: every "40 days ago" would land before 1970.
   */
  const WAN_NOW = 1_800_000_000_000

  const at = (overrides: Partial<BuildDeviceRowsInput> = {}) =>
    input({ now: WAN_NOW, ...overrides })

  /** Provisioned for WebRTC, seen a second ago, on the realistic clock. */
  const live = (overrides: Partial<PairedDeviceRow> = {}) =>
    wanPhone({ pairedAt: WAN_NOW - 400 * DAY, lastSeenAt: WAN_NOW - 1_000, ...overrides })

  it("reports an automatic connection for a provisioned, active, recently-seen device", () => {
    const wan = buildDeviceWan(live(), at(), "active")
    expect(wan.state).toBe("automatic")
    expect(wan.canWake).toBe(false)
    expect(wan.lastEvidenceAt).toBe(WAN_NOW - 1_000)
  })

  it("reports dormant, and only dormant offers the button", () => {
    const wan = buildDeviceWan(live({ lastSeenAt: WAN_NOW - 40 * DAY }), at(), "active")
    expect(wan.state).toBe("dormant")
    expect(wan.canWake).toBe(true)
    expect(wan.lastEvidenceAt).toBe(WAN_NOW - 40 * DAY)
  })

  it("keeps a device just inside the window connected", () => {
    expect(buildDeviceWan(live({ lastSeenAt: WAN_NOW - 29 * DAY }), at(), "active").state).toBe(
      "automatic"
    )
  })

  it("reports woken once the owner has asked for a connection", () => {
    const wan = buildDeviceWan(
      live({ lastSeenAt: WAN_NOW - 40 * DAY }),
      at({ wokenWanDeviceIds: new Set(["d1"]) }),
      "active"
    )
    expect(wan.state).toBe("woken")
    // Already connected, so there is nothing left to click.
    expect(wan.canWake).toBe(false)
  })

  it("ignores a wake for a device that was never dormant", () => {
    expect(buildDeviceWan(live(), at({ wokenWanDeviceIds: new Set(["d1"]) }), "active").state).toBe(
      "automatic"
    )
  })

  it("says unprovisioned for a row paired before WebRTC existed", () => {
    // Not "dormant": no button would help, because there is no room to join.
    const wan = buildDeviceWan(
      phone({ pairedAt: WAN_NOW - 400 * DAY, lastSeenAt: WAN_NOW - 40 * DAY }),
      at(),
      "active"
    )
    expect(wan.state).toBe("unprovisioned")
    expect(wan.canWake).toBe(false)
  })

  it("says unprovisioned for a v1 room descriptor", () => {
    const legacy = live()
    const row = {
      ...legacy,
      signalingRoomDescriptor: { ...legacy.signalingRoomDescriptor!, v: 1 as unknown as 2 },
    }
    expect(buildDeviceWan(row, at(), "active").state).toBe("unprovisioned")
  })

  it("says blocked for a paused or revoked device rather than dormant", () => {
    // The deny-list is the reason, and resuming is a different control. Calling
    // it dormant would send the owner to a wake button that cannot help.
    const stale = live({ lastSeenAt: WAN_NOW - 40 * DAY })
    expect(buildDeviceWan(stale, at(), "paused").state).toBe("blocked")
    expect(buildDeviceWan(stale, at(), "revoked").state).toBe("blocked")
    expect(buildDeviceWan(stale, at(), "paused").canWake).toBe(false)
  })

  /**
   * `adminState` prefers what the HOST reported. The hub push filters on the
   * mirror row's own `pausedAt` / `revokedAt`. When the two disagree (the
   * condition the row records as `adminStateConflict`) the console has to
   * answer from the fields the hub actually reads, or it describes a rule
   * nobody is applying.
   */
  it("says blocked from the mirror row even when the host still calls it active", () => {
    const paused = live({ pausedAt: WAN_NOW - 2 * DAY })
    expect(buildDeviceWan(paused, at(), "active").state).toBe("blocked")
    expect(buildDeviceWan(paused, at(), "active").canWake).toBe(false)

    const revoked = live({ revokedAt: WAN_NOW - 2 * DAY })
    expect(buildDeviceWan(revoked, at(), "active").state).toBe("blocked")
  })

  it("never offers a wake the hub push would filter straight back out", () => {
    // The dead-button case: idle past the window AND paused in the mirror. The
    // old ordering read `adminState` alone, returned `dormant` with
    // `canWake: true`, and every press re-pushed a list `isWanBlocked` dropped.
    const wan = buildDeviceWan(
      live({ lastSeenAt: WAN_NOW - 40 * DAY, pausedAt: WAN_NOW - 2 * DAY }),
      at(),
      "active"
    )
    expect(wan.state).toBe("blocked")
    expect(wan.canWake).toBe(false)
  })

  it("says unmanaged before it consults the master switch", () => {
    // A picker that never renders this facet passes `holdsWanConnections:
    // false` and no switch at all. It must not come out as "turned off", which
    // is a claim about the user's settings rather than about this surface.
    const { wanEnabled: _omitted, ...noSwitch } = at({ holdsWanConnections: false })
    expect(buildDeviceWan(live(), noSwitch, "active").state).toBe("unmanaged")
  })

  it("says unmanaged on a shell that does not run the hub", () => {
    // A phone or a browser reading this console genuinely does not know whether
    // the desktop is holding a socket, and cannot start one.
    const wan = buildDeviceWan(live(), at({ holdsWanConnections: false }), "active")
    expect(wan.state).toBe("unmanaged")
    expect(wan.canWake).toBe(false)
  })

  it("treats an absent master switch as on, exactly as the hub does", () => {
    // `buildSignalingConfigPatch` reads `webrtcEnabled ?? true`, so a settings
    // row written before the toggle existed must not read as switched off.
    const { wanEnabled: _omitted, ...withoutSwitch } = at()
    expect(buildDeviceWan(live(), withoutSwitch, "active").state).toBe("automatic")
  })

  it("says disabled when the WebRTC master switch is off", () => {
    // Distinct from dormant: waking would do nothing until the switch is back.
    const wan = buildDeviceWan(
      live({ lastSeenAt: WAN_NOW - 40 * DAY }),
      at({ wanEnabled: false }),
      "active"
    )
    expect(wan.state).toBe("disabled")
    expect(wan.canWake).toBe(false)
  })

  it("prefers the structural reason over every later one", () => {
    // An unprovisioned, paused device on a non-desktop shell with the switch
    // off still reads "unprovisioned", because that is the fact that decides.
    expect(
      buildDeviceWan(
        phone({ pairedAt: WAN_NOW - 400 * DAY, lastSeenAt: WAN_NOW - 40 * DAY }),
        at({ holdsWanConnections: false, wanEnabled: false }),
        "paused"
      ).state
    ).toBe("unprovisioned")
  })

  it("omits the timestamp entirely when the row carries no evidence", () => {
    // "Never" rather than "1970", which is what a raw 0 would render as.
    const wan = buildDeviceWan(live({ lastSeenAt: 0, pairedAt: 0 }), at(), "active")
    expect(wan.lastEvidenceAt).toBeUndefined()
    expect(wan.state).toBe("dormant")
  })

  it("is attached to paired-device rows and to nothing else", () => {
    const rows = buildDeviceRows(
      input({
        pairedDevices: [wanPhone()],
        remoteHosts: [host()],
        workers: [worker()],
        sshHosts: [
          { id: "s1", name: "box", host: "h", port: 22, username: "u", authMethod: "agent" },
        ],
      })
    )
    expect(find(rows, pairedDeviceRef("d1")).wan?.state).toBe("automatic")
    for (const row of rows.filter((candidate) => candidate.kind !== "paired-device")) {
      expect(row.wan).toBeUndefined()
    }
  })

  it("matches the hub filter: exactly the rows selectSignalingDevices keeps read as connected", () => {
    // The console and the controller must not describe two different rules, so
    // both read the same `isWanDormant` leaf and this pins the agreement.
    const rows = [
      live({ deviceId: "fresh", rendezvousId: "r-fresh" }),
      live({ deviceId: "stale", rendezvousId: "r-stale", lastSeenAt: WAN_NOW - 40 * DAY }),
      live({ deviceId: "paused", rendezvousId: "r-paused", pausedAt: WAN_NOW }),
      phone({ deviceId: "legacy", pairedAt: WAN_NOW - DAY, lastSeenAt: WAN_NOW - DAY }),
    ]
    const connectedHere = rows
      .filter((row) =>
        ["automatic", "woken"].includes(
          buildDeviceWan(row, at(), row.pausedAt ? "paused" : "active").state
        )
      )
      .map((row) => row.deviceId)
    const connectedInHub = selectSignalingDevices(rows, { now: WAN_NOW }).map((d) => d.deviceId)
    expect(connectedHere).toEqual(["fresh"])
    expect(connectedInHub).toEqual(connectedHere)
  })
})

/**
 * A saved SSH host carries no presence of its own, so the console painted every
 * one of them `unknown` forever. An explicit Test connection is the only signal
 * there is, and these pin what each of its three answers means.
 */
describe("SSH host reachability from a probe", () => {
  const SSH: SshHostInput = {
    id: "s1",
    name: "prod-web-01",
    host: "10.0.4.21",
    port: 22,
    username: "deploy",
    authMethod: "agent",
  }

  function sshRow(sshProbes?: ReadonlyMap<string, { online: boolean; at: number }>) {
    const rows = buildDeviceRows(input({ sshHosts: [SSH], sshProbes }))
    const row = rows.find((candidate) => candidate.kind === "ssh-host")
    if (!row) throw new Error("expected an ssh-host row")
    return row
  }

  it("stays unknown until somebody asks", () => {
    expect(sshRow().reachability).toBe("unknown")
    expect(sshRow().lastSeenAt).toBeUndefined()
  })

  it("reports online, and dates the answer, once a probe succeeds", () => {
    const row = sshRow(new Map([["s1", { online: true, at: NOW - 1_000 }]]))
    expect(row.reachability).toBe("online")
    expect(row.lastSeenAt).toBe(NOW - 1_000)
  })

  /**
   * The distinction this exists to protect. `deriveReachability` reads a stream
   * of presence, where a recent timestamp with `online: false` means "was here,
   * may not be able to act" and maps to `recently-active`. A probe is one
   * question, and a refusal to it means offline now.
   */
  it("reports offline for a refusal rather than recently-active", () => {
    expect(sshRow(new Map([["s1", { online: false, at: NOW - 1_000 }]])).reachability).toBe(
      "offline"
    )
  })

  /** A refusal is evidence about a machine, not evidence it was reachable. */
  it("does not claim a last-seen time for a host that refused", () => {
    expect(sshRow(new Map([["s1", { online: false, at: NOW - 1_000 }]])).lastSeenAt).toBeUndefined()
  })

  it("ignores a probe recorded against some other host", () => {
    expect(sshRow(new Map([["other", { online: true, at: NOW }]])).reachability).toBe("unknown")
  })
})
