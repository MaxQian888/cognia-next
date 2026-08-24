import {
  buildDeviceOptions,
  buildDevicePlacement,
  deviceCandidates,
  placementKindFor,
  requireHostFeature,
  requirePlatform,
  requireSandboxTier,
} from "./placement-directory"
import type { DeviceRow, DeviceShellTierRow } from "./types"
import type { PlacementLiveness } from "@/lib/placement/liveness"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"

const NOW = 1_000_000

const FRESH: PlacementLiveness = { online: true, lastSeenAt: NOW, source: "request" }
const LOCAL_LIVE: PlacementLiveness = { online: true, lastSeenAt: NOW, source: "local" }

function manifest(features: HostFeatureManifest["features"]): HostFeatureManifest {
  return {
    schemaVersion: 2,
    hostBuildId: "1.0.0",
    platform: "tauri",
    generatedAt: 1,
    features,
    limits: {
      rpcJsonBodyBytes: 1,
      skillMaxResources: 1,
      skillMaxResourceBytes: 1,
      skillUploadChunkBytes: 1,
      mcpRequestBodyBytes: 1,
      maxConcurrentProxyCalls: 1,
    },
    hostIdentity: { id: "host-1", kind: "desktop" },
    protocol: { min: 1, max: 2 },
    operations: [],
    deviceGrants: [],
  }
}

const TIERS: DeviceShellTierRow[] = [
  { tier: "os", available: true },
  { tier: "microvm", available: false, reasonKey: "microvmAdapterMissing" },
  { tier: "cua-desktop", available: false, reasonKey: "cuaDesktopRetired" },
]

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: FRESH,
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: buildDevicePlacement({
      kind: "paired-device",
      platformCapabilities: ["camera"],
    }),
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

describe("placementKindFor", () => {
  it("is the identity — the console and the resolver share one candidate space", () => {
    expect(placementKindFor("local")).toBe("local")
    expect(placementKindFor("paired-device")).toBe("paired-device")
    expect(placementKindFor("remote-host")).toBe("remote-host")
    expect(placementKindFor("worker")).toBe("worker")
  })
})

describe("buildDevicePlacement", () => {
  it("keeps each vocabulary in its own dimension", () => {
    const placement = buildDevicePlacement({
      kind: "remote-host",
      platformCapabilities: ["headless"],
      agentCapabilities: ["streaming"],
      featureManifest: manifest({ "workflow.execution": { version: 1, operations: ["run"] } }),
    })
    expect(placement.provides).toEqual(
      expect.arrayContaining([
        { dimension: "platform", value: "headless" },
        { dimension: "agent", value: "streaming" },
        { dimension: "host-feature", value: "workflow.execution" },
      ])
    )
  })

  /**
   * `PlacementDimension` has carried `"sandbox"` since ADR-0136 and nothing
   * ever produced a value for it, so `sandbox_mismatch` was a reason no
   * candidate could trigger. This is the wiring that closes that.
   */
  it("offers only the sandbox tiers that can actually execute", () => {
    const placement = buildDevicePlacement({ kind: "local", shellTiers: TIERS })
    expect(placement.provides.filter((r) => r.dimension === "sandbox")).toEqual([
      { dimension: "sandbox", value: "os" },
    ])
  })

  it("never claims capacity it cannot observe", () => {
    const placement = buildDevicePlacement({ kind: "paired-device" })
    expect(placement.activeUnits).toBe(0)
    expect(placement.maxUnits).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("deviceCandidates", () => {
  it("reads liveness from the row, so there is only ever one copy of it", () => {
    const stale: PlacementLiveness = { online: true, lastSeenAt: 42, source: "request" }
    const [candidate] = deviceCandidates([row({ liveness: stale })])
    expect(candidate!.liveness).toBe(stale)
  })

  it("carries identity and load, with labels for diagnostics only", () => {
    const [candidate] = deviceCandidates([row()])
    expect(candidate).toMatchObject({
      ref: "device:a",
      kind: "paired-device",
      activeUnits: 0,
      labels: { label: "Phone", kind: "paired-device", reachability: "online" },
    })
    expect(candidate!.provides).toEqual([{ dimension: "platform", value: "camera" }])
  })
})

describe("buildDeviceOptions", () => {
  const host = row({
    ref: "host-1",
    kind: "remote-host",
    label: "Build box",
    liveness: { online: true, lastSeenAt: NOW, source: "manifest" },
    placement: buildDevicePlacement({
      kind: "remote-host",
      featureManifest: manifest({ "workflow.execution": { version: 1, operations: ["run"] } }),
    }),
  })

  it("marks a host that advertises the required feature eligible", () => {
    const options = buildDeviceOptions([host], [requireHostFeature("workflow.execution")], NOW)
    expect(options[0]).toMatchObject({ eligible: true, verdict: { ready: true } })
  })

  /**
   * The behaviour this replaces: the workflow editor filtered its Select down
   * to hosts carrying `workflow.execution` and silently dropped the rest, so
   * an offline host and an unpaired one looked identical — absent.
   */
  it("returns ineligible candidates with a reason instead of dropping them", () => {
    const options = buildDeviceOptions(
      [host, row()],
      [requireHostFeature("workflow.execution")],
      NOW
    )
    expect(options).toHaveLength(2)
    const phone = options.find((option) => option.row.ref === "device:a")
    expect(phone?.eligible).toBe(false)
    expect(phone?.verdict).toMatchObject({
      ready: false,
      reason: "capability_mismatch",
      missing: [{ dimension: "host-feature", value: "workflow.execution" }],
    })
  })

  it("reports a stale candidate as offline rather than incompatible", () => {
    const stale = row({
      liveness: { online: true, lastSeenAt: NOW - 10 * 60_000, source: "request" },
    })
    const options = buildDeviceOptions([stale], [requirePlatform("camera")], NOW)
    expect(options[0]!.verdict).toMatchObject({ ready: false, reason: "offline" })
  })

  it("names a missing sandbox tier as a sandbox mismatch", () => {
    const local = row({
      ref: "local",
      kind: "local",
      liveness: LOCAL_LIVE,
      placement: buildDevicePlacement({ kind: "local", shellTiers: TIERS }),
    })
    expect(
      buildDeviceOptions([local], [requireSandboxTier("microvm")], NOW)[0]!.verdict
    ).toMatchObject({ ready: false, reason: "sandbox_mismatch" })
    expect(buildDeviceOptions([local], [requireSandboxTier("os")], NOW)[0]!.eligible).toBe(true)
  })
})
