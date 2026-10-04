import type { DeviceCapabilityCell, DeviceRow } from "./types"
import {
  canOwnTiming,
  packHalfSections,
  planDeviceSections,
  type DevicePlannedSection,
} from "./section-plan"

const CELL: DeviceCapabilityCell = {
  id: "pty",
  group: "platform",
  state: "reported",
  source: "device-report",
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [CELL],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", reasonKey: "sandboxNotHosted", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported", reasonKey: "workspaceNotHosted" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

const ids = (sections: readonly DevicePlannedSection[]) => sections.map((section) => section.id)

describe("planDeviceSections", () => {
  it("leads a phone with its grants, and states what it does not host once", () => {
    const plan = planDeviceSections(
      row({
        deviceId: "dev-1",
        wan: { state: "automatic", canWake: false },
        presence: { eventPlane: "ready", attention: "foreground", streams: [] },
      })
    )
    expect(ids(plan.sections)).toEqual([
      "access",
      "wan",
      "presence",
      "event-plane",
      "identity",
      "dispatch",
      "capabilities",
      "placement",
    ])
    expect(plan.notApplicable.map((entry) => entry.id)).toEqual(["sandbox", "workspaces"])
    expect(plan.notApplicable[0]?.reasonKey).toBe("runtime.reason.sandboxNotHosted")
    expect(plan.notApplicableWide).toBe(false)
  })

  it("pulls the next half card up so a lone half card is not left beside a gap", () => {
    // No WAN summary and no event plane: `presence` would sit alone above the
    // wide dispatch card, so `identity` is the partner it gets.
    const plan = planDeviceSections(row({ deviceId: "dev-1" }))
    expect(ids(plan.sections)).toEqual([
      "access",
      "presence",
      "identity",
      "dispatch",
      "capabilities",
      "placement",
    ])
  })

  it("puts what the local machine runs before what it is", () => {
    const plan = planDeviceSections(
      row({
        ref: "local",
        kind: "local",
        isSelf: true,
        runtime: {
          sandbox: { support: "supported", connections: [] },
          shellTiers: [{ tier: "os", available: true }],
          workspaces: { support: "supported" },
          isRoutingTarget: true,
        },
      })
    )
    expect(ids(plan.sections)).toEqual([
      "routing",
      "shell-tiers",
      "workspaces",
      "sandbox",
      "identity",
      "presence",
      "capabilities",
      "placement",
    ])
    expect(plan.notApplicable.map((entry) => entry.id)).toEqual(["access", "dispatch"])
    expect(plan.notApplicable[0]?.reasonKey).toBe("access.notApplicable.local")
  })

  it("keeps an inactive remote host's workspace card, because it can be probed", () => {
    const plan = planDeviceSections(
      row({
        ref: "host:h1",
        kind: "remote-host",
        hostId: "h1",
        runtime: {
          sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
          shellTiers: [],
          workspaces: { support: "requires-activation", reasonKey: "activateToInspect" },
          isRoutingTarget: false,
        },
      })
    )
    // `presence` would sit alone above the wide capability matrix, so the
    // placement card, the only remaining half, is pulled up beside it.
    expect(ids(plan.sections)).toEqual([
      "workspaces",
      "routing",
      "identity",
      "presence",
      "placement",
      "capabilities",
      "dispatch",
    ])
    expect(plan.notApplicable.map((entry) => entry.reasonKey)).toEqual([
      "access.notApplicable.remote-host",
      "runtime.reason.sandboxIsClientLocal",
    ])
  })

  it("drops routing for a /pair host the store cannot address and is not routed to", () => {
    const pairHost = row({ ref: "companion:x", kind: "remote-host", hostId: undefined })
    expect(canOwnTiming(pairHost)).toBe(false)
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("routing")
    const routed = { ...pairHost, runtime: { ...pairHost.runtime, isRoutingTarget: true } }
    expect(ids(planDeviceSections(routed).sections)).toContain("routing")
  })

  it("moves a worker's missing capability vocabulary into the shared record", () => {
    const plan = planDeviceSections(
      row({
        ref: "worker:w",
        kind: "worker",
        capabilities: [],
        runtime: {
          sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
          shellTiers: [],
          workspaces: { support: "unsupported", reasonKey: "workerNoRoutingPlane" },
          isRoutingTarget: false,
        },
      })
    )
    expect(ids(plan.sections)).toEqual(["identity", "presence", "dispatch", "placement"])
    expect(plan.notApplicable.map((entry) => entry.id)).toEqual([
      "capabilities",
      "access",
      "sandbox",
      "workspaces",
    ])
    expect(plan.notApplicableWide).toBe(true)
  })

  it("gives an SSH host its two real cards and one record for the rest", () => {
    const plan = planDeviceSections(
      row({ ref: "ssh:p1", kind: "ssh-host", capabilities: [], deviceId: undefined })
    )
    expect(ids(plan.sections)).toEqual(["ssh", "files", "identity", "presence"])
    expect(plan.notApplicable.map((entry) => entry.id)).toEqual([
      "capabilities",
      "access",
      "runtime",
      "dispatch",
      "placement",
    ])
    expect(plan.notApplicable.find((entry) => entry.id === "runtime")?.reasonKey).toBe(
      "runtime.reason.sshShellOnly"
    )
  })

  it("never lists one card twice or in both halves of the plan", () => {
    for (const kind of ["local", "paired-device", "remote-host", "worker", "ssh-host"] as const) {
      const plan = planDeviceSections(row({ kind, hostId: "h", deviceId: "d" }))
      const sectionIds = ids(plan.sections)
      expect(new Set(sectionIds).size).toBe(sectionIds.length)
      for (const entry of plan.notApplicable) {
        expect(sectionIds).not.toContain(entry.id)
      }
    }
  })
})

describe("packHalfSections", () => {
  const half = (id: DevicePlannedSection["id"]) => ({ id, wide: false })
  const wide = (id: DevicePlannedSection["id"]) => ({ id, wide: true })

  it("leaves an already paired order alone", () => {
    const input = [half("identity"), half("presence"), wide("dispatch")]
    expect(packHalfSections(input)).toEqual(input)
  })

  it("only pulls the nearest half card, and only upwards", () => {
    expect(
      ids(
        packHalfSections([
          wide("access"),
          half("wan"),
          wide("dispatch"),
          half("identity"),
          half("placement"),
        ])
      )
    ).toEqual(["access", "wan", "identity", "dispatch", "placement"])
  })

  it("leaves a final half card where it is when nothing can partner it", () => {
    expect(ids(packHalfSections([half("identity"), wide("dispatch")]))).toEqual([
      "identity",
      "dispatch",
    ])
  })
})
