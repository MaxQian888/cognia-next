import type { DeviceCapabilityCell, DeviceRow } from "./types"
import {
  canOwnTiming,
  packHalfSections,
  planDeviceSections,
  type DevicePlannedSection,
  managementRefOf,
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
    // The browser build brokers no remote desktops, and says so once.
    expect(plan.notApplicable.map((entry) => entry.id)).toEqual([
      "access",
      "remote-desktop",
      "dispatch",
    ])
    expect(plan.notApplicable[0]?.reasonKey).toBe("access.notApplicable.local")
    expect(plan.notApplicable[1]?.reasonKey).toBe("remoteDesktop.desktopOnly")
  })

  it("lists remote desktops after the sandbox on the desktop shell, and nowhere else", () => {
    const runtime = {
      sandbox: { support: "supported" as const, connections: [] },
      shellTiers: [{ tier: "os" as const, available: true }],
      workspaces: { support: "supported" as const },
      isRoutingTarget: true,
    }
    const local = planDeviceSections(
      row({ ref: "local", kind: "local", isSelf: true, remoteDesktopHost: true, runtime })
    )
    expect(ids(local.sections)).toEqual([
      "routing",
      "shell-tiers",
      "workspaces",
      "sandbox",
      "remote-desktop",
      "identity",
      "presence",
      "capabilities",
      "placement",
    ])
    expect(local.sections.find((section) => section.id === "remote-desktop")?.wide).toBe(true)
    expect(local.notApplicable.map((entry) => entry.id)).not.toContain("remote-desktop")
    // A flag on any other row is ignored, and no other kind reports its absence.
    const phone = planDeviceSections(row({ deviceId: "dev-1", remoteDesktopHost: true }))
    expect(ids(phone.sections)).not.toContain("remote-desktop")
    expect(phone.notApplicable.map((entry) => entry.id)).not.toContain("remote-desktop")
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
    // The halves already pair (routing with identity, the Host's system with
    // presence), so placement keeps its place after the wide cards.
    expect(ids(plan.sections)).toEqual([
      "always-on",
      "host-secrets",
      "host-updates",
      "host-runtimes",
      "sandbox",
      "workspaces",
      "routing",
      "identity",
      "host-system",
      "presence",
      "capabilities",
      "dispatch",
      "placement",
    ])
    expect(plan.notApplicable.map((entry) => entry.reasonKey)).toEqual([
      "access.notApplicable.remote-host",
    ])
  })

  it("drops routing for a /pair host the store cannot address and is not routed to", () => {
    const pairHost = row({ ref: "companion:x", kind: "remote-host", hostId: undefined })
    expect(canOwnTiming(pairHost)).toBe(false)
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("routing")
    // Nor can always-on work be moved to it: a move names the host by its id.
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("always-on")
    // Nor can its secrets be managed: they go over a channel named by that id.
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("host-secrets")
    // Nor its updates, for the same reason.
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("host-updates")
    // Nor read its system details or its runtimes.
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("host-system")
    expect(ids(planDeviceSections(pairHost).sections)).not.toContain("host-runtimes")
    const routed = { ...pairHost, runtime: { ...pairHost.runtime, isRoutingTarget: true } }
    expect(ids(planDeviceSections(routed).sections)).toContain("routing")
  })

  it("manages the /pair Host this app is connected to over the app's own connection", () => {
    const pairHost = row({ ref: "companion:x", kind: "remote-host", hostId: undefined })
    const routed = { ...pairHost, runtime: { ...pairHost.runtime, isRoutingTarget: true } }
    expect(managementRefOf(routed)).toBe("companion:x")
    expect(managementRefOf(pairHost)).toBeNull()
    const sections = ids(planDeviceSections(routed).sections)
    expect(sections).toContain("host-secrets")
    expect(sections).toContain("host-updates")
    expect(sections).toContain("host-runtimes")
    expect(sections).toContain("host-system")
    // Still nothing to move: a client paired to it already runs everything there.
    expect(sections).not.toContain("always-on")
    // A store host is managed by its store id, routed or not.
    expect(managementRefOf(row({ ref: "host:h1", kind: "remote-host", hostId: "h1" }))).toBe("h1")
    expect(managementRefOf(row({ ref: "device:a", kind: "paired-device" }))).toBeNull()
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
