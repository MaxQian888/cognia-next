/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { requireHostFeature, requirePlatform } from "@/lib/devices/placement-directory"
import type { RemoteHostInput } from "@/lib/devices/types"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import { useDeviceOptions } from "./use-device-options"

const NOW = 1_700_000_000_000

let pairedRows: PairedDeviceRow[] = []
let hosts: RemoteHostInput[] = []

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => pairedRows }))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: jest.fn() }))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) =>
    selector({ hosts, activeHostId: null }),
}))
jest.mock("@/lib/device/device-identity", () => ({ getFriendlyDeviceLabel: () => "This Mac" }))
jest.mock("@/lib/companion/device-presence-registry", () => ({
  devicePresence: () => null,
  RECENTLY_ACTIVE_WINDOW_MS: 300_000,
}))

const HOST_FEATURE = Object.freeze([requireHostFeature("workflow.execution")])

function host(overrides: Partial<RemoteHostInput> = {}): RemoteHostInput {
  return {
    id: "h1",
    label: "Build box",
    connectionState: "ready",
    addedAt: NOW - 1000,
    lastConnectedAt: NOW - 100,
    config: { baseUrl: "https://build.local", serverVersion: "2.0.0" },
    featureManifest: {
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
      hostIdentity: { id: "published-id", kind: "desktop" },
      protocol: { min: 1, max: 2 },
      operations: [],
      deviceGrants: [],
    },
    featureManifestAt: NOW,
    ...overrides,
  }
}

function phone(): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Phone",
    platform: "ios",
    pubkey: "k",
    pairedAt: NOW,
    lastSeenAt: NOW,
    allowRemoteTerminal: false,
    appVersion: "1.0.0",
  }
}

beforeEach(() => {
  pairedRows = []
  hosts = []
})

describe("useDeviceOptions", () => {
  it("marks a host advertising the requirement eligible", () => {
    hosts = [host()]
    const { result } = renderHook(() =>
      useDeviceOptions({ requirements: HOST_FEATURE, kinds: ["remote-host"], now: NOW })
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({ eligible: true, row: { ref: "published-id" } })
  })

  /**
   * The behaviour this replaces: the workflow editor filtered its Select down
   * to compatible hosts, so an offline one and an unpaired one looked
   * identical — absent — and "why can this not run there?" had no answer.
   */
  it("keeps an incompatible host in the list, with a reason", () => {
    hosts = [host({ featureManifest: undefined, featureManifestAt: undefined })]
    const { result } = renderHook(() =>
      useDeviceOptions({ requirements: HOST_FEATURE, kinds: ["remote-host"], now: NOW })
    )
    expect(result.current[0]).toMatchObject({
      eligible: false,
      verdict: { reason: "capability_mismatch" },
    })
  })

  it("reports an unreachable host as offline rather than incompatible", () => {
    hosts = [host({ connectionState: "disconnected", lastConnectedAt: NOW - 86_400_000 })]
    const { result } = renderHook(() =>
      useDeviceOptions({ requirements: HOST_FEATURE, kinds: ["remote-host"], now: NOW })
    )
    expect(result.current[0]!.verdict).toMatchObject({ reason: "offline" })
  })

  it("scopes the list to the kinds a caller can actually target", () => {
    hosts = [host()]
    pairedRows = [phone()]
    const { result } = renderHook(() =>
      useDeviceOptions({ requirements: HOST_FEATURE, kinds: ["remote-host"], now: NOW })
    )
    expect(result.current.map((option) => option.row.kind)).toEqual(["remote-host"])
  })

  it("includes every kind when no scope is given", () => {
    hosts = [host()]
    pairedRows = [phone()]
    const { result } = renderHook(() => useDeviceOptions({ requirements: [], now: NOW }))
    expect(result.current.map((option) => option.row.kind).sort()).toEqual([
      "local",
      "paired-device",
      "remote-host",
    ])
  })

  it("judges a phone against the platform vocabulary it reported", () => {
    pairedRows = [{ ...phone(), capabilities: ["camera"], capabilitiesReportedAt: NOW }]
    const { result } = renderHook(() =>
      useDeviceOptions({
        requirements: [requirePlatform("camera")],
        kinds: ["paired-device"],
        now: NOW,
      })
    )
    expect(result.current[0]).toMatchObject({ eligible: true })
  })
})
