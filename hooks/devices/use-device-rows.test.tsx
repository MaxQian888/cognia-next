/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import {
  recordSshProbe,
  resetSshProbesForTests,
  SSH_PROBE_TTL_MS,
  sshProbeTarget,
} from "@/lib/devices/ssh-probe-store"
import { resetWanWakeOverridesForTests, wakeDeviceForWan } from "@/lib/signaling/wan-wake-overrides"

import { useDeviceRows } from "./use-device-rows"

const pairedRows: unknown[] = []
let listWorkersImpl: () => Promise<unknown[]> = async () => []
let transportCallImpl: (name: string) => Promise<unknown> = async () => []
let tauri = true
let sshHostSettings: unknown[] | undefined = []
/** `AppSettings.webrtcEnabled`. Absent means on, as the hub reads it. */
let webrtcEnabled: boolean | undefined
/** `AppSettings | null`: the store is null until `load()` resolves. */
let settingsLoaded = true
let runtimeAvailability = {
  os: { available: true, backend: "seatbelt", reason: "available", detail: "" },
  microvm: { available: false, reason: "adapter-missing", requiresWorkspace: true },
}

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

jest.mock("@/hooks/sandbox/use-sandbox-runtime-availability", () => ({
  useSandboxRuntimeAvailability: () => runtimeAvailability,
}))

jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) =>
    selector({ hosts: [], activeHostId: null }),
}))

/**
 * The real settings store pulls in the keyring at module scope, which throws
 * in this env. Only the SSH host list is read here.
 */
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector(
      settingsLoaded
        ? { settings: { terminal: { sshHosts: sshHostSettings }, webrtcEnabled } }
        : { settings: null }
    ),
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
  sshHostSettings = []
  webrtcEnabled = undefined
  settingsLoaded = true
  resetWanWakeOverridesForTests()
  listWorkersImpl = async () => []
  transportCallImpl = async () => []
  runtimeAvailability = {
    os: { available: true, backend: "seatbelt", reason: "available", detail: "" },
    microvm: { available: false, reason: "adapter-missing", requiresWorkspace: true },
  }
  jest.clearAllMocks()
})

describe("useDeviceRows", () => {
  it("always includes this machine, even with nothing paired", async () => {
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]).toMatchObject({ ref: "local", isSelf: true })
    expect(result.current.rows[0]?.runtime.shellTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "os", available: true }),
        expect.objectContaining({ tier: "microvm", available: false }),
      ])
    )
    expect(result.current.summary).toMatchObject({ total: 1, online: 1 })
  })

  it("projects the shared runtime availability into local shell tiers", async () => {
    runtimeAvailability = {
      os: { available: false, backend: "seatbelt", reason: "probe-failed", detail: "failed" },
      microvm: { available: true, reason: "workspace-required", requiresWorkspace: true },
    }

    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows[0]?.runtime.shellTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "os", available: false }),
        expect.objectContaining({ tier: "microvm", available: true }),
      ])
    )
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

  /**
   * The SSH list is the one input that comes from settings rather than a
   * device registry, and it reached the hook through a key `AppSettings` does
   * not have (`terminalSettings`) — which reads as `undefined`, so every saved
   * host silently vanished from the console. This pins the real path.
   */
  it("lists saved SSH hosts from settings", async () => {
    sshHostSettings = [
      {
        id: "s1",
        name: "prod-web-01",
        host: "10.0.4.21",
        port: 22,
        username: "deploy",
        authMethod: "privateKey",
      },
    ]
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.find((row) => row.ref === "ssh:s1")).toMatchObject({
      kind: "ssh-host",
      label: "prod-web-01",
    })
  })

  /**
   * Settings are `AppSettings | null` and stay null until `load()` resolves, so
   * the selector runs against a null store on the first paint of `/devices`.
   * Reading through it without a guard threw inside the selector and took the
   * page down before any device could be listed.
   */
  it("renders the rest of the fleet before settings have loaded", async () => {
    settingsLoaded = false
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.some((row) => row.ref === "local")).toBe(true)
    expect(result.current.rows.every((row) => row.kind !== "ssh-host")).toBe(true)
  })

  it("lists no SSH row when the user has saved none", async () => {
    sshHostSettings = undefined
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.every((row) => row.kind !== "ssh-host")).toBe(true)
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

describe("useDeviceRows — WAN dormancy", () => {
  const DAY = 24 * 60 * 60 * 1000

  /** A phone provisioned for WebRTC, silent for the given number of days. */
  function pushPhone(idleDays: number) {
    pairedRows.push({
      deviceId: "d1",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "1.0.0",
      pairedAt: Date.now() - 400 * DAY,
      lastSeenAt: Date.now() - idleDays * DAY,
      allowRemoteTerminal: false,
      rendezvousId: "r1",
      signalingKeyRef: "kr:d1",
      signalingRoomDescriptor: {
        v: 2,
        roomId: "r1",
        roomNonce: "n",
        desktopSigningKey: "dk",
        mobileSigningKey: "mk",
        notAfter: Date.now() + DAY,
      },
    })
  }

  async function wanState() {
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    return result
  }

  it("marks a phone silent past the window as dormant", async () => {
    pushPhone(40)
    const result = await wanState()
    expect(result.current.rows.find((row) => row.deviceId === "d1")?.wan).toMatchObject({
      state: "dormant",
      canWake: true,
    })
  })

  it("leaves a recently-active phone connected", async () => {
    pushPhone(1)
    const result = await wanState()
    expect(result.current.rows.find((row) => row.deviceId === "d1")?.wan?.state).toBe("automatic")
  })

  it("re-renders as woken when the owner asks for a connection", async () => {
    // The override set is a plain module singleton, so this is also the pin
    // that the console is actually subscribed to it.
    pushPhone(40)
    const result = await wanState()
    act(() => wakeDeviceForWan("d1"))
    await waitFor(() =>
      expect(result.current.rows.find((row) => row.deviceId === "d1")?.wan?.state).toBe("woken")
    )
  })

  it("says unmanaged off the desktop rather than guessing", async () => {
    tauri = false
    pushPhone(1)
    const result = await wanState()
    expect(result.current.rows.find((row) => row.deviceId === "d1")?.wan?.state).toBe("unmanaged")
  })

  it("says disabled when the WebRTC master switch is off", async () => {
    webrtcEnabled = false
    pushPhone(40)
    const result = await wanState()
    expect(result.current.rows.find((row) => row.deviceId === "d1")?.wan?.state).toBe("disabled")
  })
})

/**
 * A saved SSH host has no presence of its own, so the only signal is an
 * explicit Test connection. These pin that the answer travels from the probe
 * store into the row, and that the two ways it can stop being true both put
 * the row back on `unknown` rather than leaving a stale claim on screen.
 */
describe("useDeviceRows — SSH probe results", () => {
  const PROFILE = {
    id: "s1",
    name: "prod-web-01",
    host: "10.0.4.21",
    port: 22,
    username: "deploy",
    authMethod: "privateKey" as const,
  }

  beforeEach(() => {
    resetSshProbesForTests()
    sshHostSettings = [PROFILE]
  })

  afterEach(() => {
    resetSshProbesForTests()
  })

  async function sshRow() {
    const { result } = renderHook(() => useDeviceRows())
    await waitFor(() => expect(result.current.loading).toBe(false))
    return result.current.rows.find((row) => row.ref === "ssh:s1")
  }

  it("stays unknown while nobody has asked", async () => {
    expect(await sshRow()).toMatchObject({ reachability: "unknown" })
  })

  it("goes online once a probe has answered", async () => {
    recordSshProbe("s1", {
      online: true,
      at: Date.now(),
      fingerprint: "SHA256:a",
      target: sshProbeTarget(PROFILE),
    })
    expect(await sshRow()).toMatchObject({ reachability: "online" })
  })

  /** Past the TTL the answer is a fact about a moment nobody has re-checked. */
  it("falls back to unknown once the answer is older than the TTL", async () => {
    recordSshProbe("s1", {
      online: true,
      at: Date.now() - SSH_PROBE_TTL_MS - 1,
      target: sshProbeTarget(PROFILE),
    })
    expect(await sshRow()).toMatchObject({ reachability: "unknown" })
  })

  /** An answer recorded before the port changed describes a different machine. */
  it("drops an answer recorded against the host's previous address", async () => {
    recordSshProbe("s1", {
      online: true,
      at: Date.now(),
      target: sshProbeTarget({ ...PROFILE, port: 2222 }),
    })
    expect(await sshRow()).toMatchObject({ reachability: "unknown" })
  })
})
