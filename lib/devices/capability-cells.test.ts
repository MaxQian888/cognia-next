import {
  HOST_EXECUTION_FEATURES,
  baselinePlatformFor,
  buildHostFeatureCells,
  buildPlatformCapabilityCells,
  summarizeCapabilityCells,
} from "./capability-cells"
import { CORE_CAPABILITY_IDS, capabilitiesForPlatform } from "@/lib/platform/capabilities"
import { HOST_FEATURE_IDS, type HostFeatureManifest } from "@/lib/platform/host-feature-manifest"

function manifest(features: HostFeatureManifest["features"]): HostFeatureManifest {
  return {
    schemaVersion: 2,
    hostBuildId: "1.0.0",
    platform: "tauri",
    generatedAt: 1_000,
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

describe("baselinePlatformFor", () => {
  it("maps both mobile platforms onto the mobile baseline", () => {
    expect(baselinePlatformFor("ios")).toBe("mobile")
    expect(baselinePlatformFor("android")).toBe("mobile")
    expect(baselinePlatformFor("web")).toBe("web")
  })

  it("refuses to invent a baseline for a device that would not name its platform", () => {
    expect(baselinePlatformFor("unknown")).toBeUndefined()
    expect(baselinePlatformFor(undefined)).toBeUndefined()
  })
})

describe("buildPlatformCapabilityCells — device has reported", () => {
  const cells = buildPlatformCapabilityCells({
    reported: ["camera", "webview", "plugin:acme"],
    reportedAt: 5_000,
    platform: "mobile",
  })
  const byId = new Map(cells.map((cell) => [cell.id, cell]))

  it("marks reported ids as reported and sourced from the device", () => {
    expect(byId.get("camera")).toMatchObject({ state: "reported", source: "device-report" })
    expect(byId.get("webview")).toMatchObject({ state: "reported" })
  })

  it("treats a complete report as a complete answer, so misses are absent not unknown", () => {
    // `biometric` IS in the mobile baseline, but this device reported without
    // it — the baseline must not override what the device actually said.
    expect(capabilitiesForPlatform("mobile")).toContain("biometric")
    expect(byId.get("biometric")).toMatchObject({ state: "absent" })
    expect(cells.some((cell) => cell.state === "unknown")).toBe(false)
    expect(cells.some((cell) => cell.state === "expected")).toBe(false)
  })

  it("appends reported plugin ids after the core catalog, sorted", () => {
    const ids = cells.map((cell) => cell.id)
    expect(ids.slice(0, CORE_CAPABILITY_IDS.length)).toEqual([...CORE_CAPABILITY_IDS])
    expect(ids.at(-1)).toBe("plugin:acme")
  })

  it("drops ids that are not well-formed capability ids", () => {
    const odd = buildPlatformCapabilityCells({
      reported: ["camera", "not a capability", "plugin:"],
      reportedAt: 1,
      platform: "mobile",
    })
    expect(odd.map((cell) => cell.id)).toEqual([...CORE_CAPABILITY_IDS])
  })
})

describe("buildPlatformCapabilityCells — device has never reported", () => {
  const cells = buildPlatformCapabilityCells({ platform: "mobile" })
  const byId = new Map(cells.map((cell) => [cell.id, cell]))

  it("never states a negative the device did not give", () => {
    expect(cells.some((cell) => cell.state === "absent")).toBe(false)
  })

  it("infers baseline members as expected and everything else as unknown", () => {
    expect(byId.get("camera")).toMatchObject({ state: "expected", source: "platform-baseline" })
    expect(byId.get("shell")).toMatchObject({ state: "unknown" })
  })

  it("knows nothing at all when the platform is unknown too", () => {
    const blind = buildPlatformCapabilityCells({})
    expect(blind.every((cell) => cell.state === "unknown")).toBe(true)
  })

  it("treats an empty report with a timestamp as a real answer, not silence", () => {
    const answered = buildPlatformCapabilityCells({
      reported: [],
      reportedAt: 9,
      platform: "mobile",
    })
    expect(answered.every((cell) => cell.state === "absent")).toBe(true)
  })
})

describe("buildHostFeatureCells", () => {
  it("reports the whole table as unknown when no manifest was exchanged", () => {
    const cells = buildHostFeatureCells(undefined)
    expect(cells).toHaveLength(HOST_FEATURE_IDS.length)
    expect(cells.every((cell) => cell.state === "unknown")).toBe(true)
  })

  it("carries version and operations as detail for advertised features", () => {
    const cells = buildHostFeatureCells(
      manifest({ "workflow.execution": { version: 1, operations: ["run", "cancel"] } })
    )
    const advertised = cells.find((cell) => cell.id === "workflow.execution")
    expect(advertised).toMatchObject({
      state: "reported",
      source: "host-manifest",
      detail: "v1 · run, cancel",
      group: "host-execution",
    })
  })

  /**
   * The manifest arrives over the wire from a host we do not control. A
   * feature named without its operations must degrade to "no detail", not take
   * the whole matrix down.
   */
  it("survives a feature descriptor with no operations list", () => {
    const cells = buildHostFeatureCells(
      manifest({
        "workflow.execution": { version: 2 } as never,
      })
    )
    expect(cells.find((cell) => cell.id === "workflow.execution")).toMatchObject({
      state: "reported",
      detail: "v2",
    })
  })

  it("splits proxy features away from execution features", () => {
    const cells = buildHostFeatureCells(manifest({}))
    const proxy = cells.find((cell) => cell.id === "browser.remote")
    expect(proxy?.group).toBe("host-proxy")
    expect(HOST_EXECUTION_FEATURES.has("workflow.execution")).toBe(true)
    expect(HOST_EXECUTION_FEATURES.has("browser.remote")).toBe(false)
  })

  it("marks unadvertised features absent once a manifest exists", () => {
    const cells = buildHostFeatureCells(manifest({}))
    expect(cells.every((cell) => cell.state === "absent")).toBe(true)
  })
})

describe("summarizeCapabilityCells", () => {
  it("counts every state, including the ones that are zero", () => {
    const totals = summarizeCapabilityCells([
      { id: "a", group: "platform", state: "reported", source: "device-report" },
      { id: "b", group: "platform", state: "absent", source: "device-report" },
      { id: "c", group: "platform", state: "absent", source: "device-report" },
    ])
    expect(totals).toEqual({ reported: 1, expected: 0, absent: 2, unknown: 0 })
  })
})
