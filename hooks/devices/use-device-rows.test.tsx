/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

import { useDeviceRows } from "./use-device-rows"

const pairedRows: unknown[] = []
let listWorkersImpl: () => Promise<unknown[]> = async () => []
let transportCallImpl: (name: string) => Promise<unknown> = async () => []
let tauri = true

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => pairedRows,
}))

jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: jest.fn() }))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: (name: string) => transportCallImpl(name) },
}))

jest.mock("@/lib/fleet/execution-workers", () => ({
  listExecutionWorkers: () => listWorkersImpl(),
}))

jest.mock("@/hooks/automation/use-sandbox-connections", () => ({
  useSandboxConnections: () => ({ connections: [] }),
}))

jest.mock("@/hooks/sandbox/use-sandbox-health", () => ({
  useSandboxHealth: () => ({
    health: { available: true, backend: "seatbelt", version: "", lastError: "" },
  }),
}))

jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) =>
    selector({ hosts: [], activeHostId: null }),
}))

jest.mock("@/lib/sandbox/microvm-bridge", () => ({ getMicrovmExec: () => null }))

/**
 * The real settings store pulls in the keyring at module scope, which throws
 * in this env. Only the SSH host list is read here.
 */
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { terminalSettings: { sshHosts: [] } } }),
}))

jest.mock("@/lib/device/device-identity", () => ({
  getFriendlyDeviceLabel: () => "This Mac",
}))

jest.mock("@/lib/companion/device-presence-registry", () => ({
  devicePresence: () => null,
  RECENTLY_ACTIVE_WINDOW_MS: 300_000,
}))

beforeEach(() => {
  pairedRows.length = 0
  tauri = true
  listWorkersImpl = async () => []
  transportCallImpl = async () => []
  jest.clearAllMocks()
})

describe("useDeviceRows", () => {
  it("always includes this machine, even with nothing paired", async () => {
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]).toMatchObject({ ref: "local", isSelf: true })
    expect(result.current.summary).toMatchObject({ total: 1, online: 1 })
  })

  it("reads the host device list when the host answers", async () => {
    pairedRows.push({
      deviceId: "d1",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      allowRemoteTerminal: false,
      appVersion: "1.0.0",
    })
    transportCallImpl = async (name) =>
      name === "companion_list_devices"
        ? [
            {
              deviceId: "d1",
              displayName: "Phone",
              role: "member",
              status: "suspended",
              createdAt: 1,
              updatedAt: 2,
              capabilities: [],
            },
          ]
        : []

    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => {
      const phone = result.current.rows.find((row) => row.ref === "device:d1")
      expect(phone).toMatchObject({ adminState: "paused", adminStateConflict: true })
    })
    expect(result.current.hostUnreachable).toBe(false)
  })

  /**
   * A console that renders nothing when the host refuses is worse than one
   * that renders the Dexie mirror and says which it is.
   */
  it("falls back to the mirror and admits it when the host refuses", async () => {
    transportCallImpl = async () => {
      throw new Error("companion security store is unavailable")
    }
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.hostUnreachable).toBe(true))
    expect(result.current.rows).toHaveLength(1)
  })

  it("does not claim the host is unreachable off-Tauri, where there is no host", async () => {
    tauri = false
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hostUnreachable).toBe(false)
  })

  /**
   * A host with no worker plane answers with an error rather than an empty
   * list. That is "no workers", not a console failure.
   */
  it("treats a worker-plane error as no workers", async () => {
    listWorkersImpl = async () => {
      throw new Error("unknown command")
    }
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.every((row) => row.kind !== "worker")).toBe(true)
  })

  it("includes enrolled workers when the host has them", async () => {
    listWorkersImpl = async () => [
      {
        deviceId: "w1",
        hostRef: "worker-1",
        displayName: "CI runner",
        role: "worker",
        status: "active",
        createdAt: 1,
        updatedAt: Date.now(),
        capabilities: ["agent.run"],
      },
    ]
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() =>
      expect(result.current.rows.some((row) => row.ref === "worker-1")).toBe(true)
    )
  })
})
