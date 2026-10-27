import {
  benefitsFromProbe,
  deriveHeartbeat,
  isPassiveTransport,
  recordPassiveProbe,
} from "./passive-heartbeat"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { connectorsHealth } from "@/lib/connectors/tauri/commands"
import { startHeartbeatSweep } from "./heartbeat-sweep"

// Heartbeats now write to the dedicated `connectorHeartbeats` table (v51);
// `fetchLastInboundAt` reads `connectorAudit` via `[adapterId+kind+at]`.
const mockHeartbeatPut = jest.fn().mockResolvedValue(undefined)
const mockGetRunningAdapter = jest.fn()

jest.mock("@/lib/connectors/lifecycle", () => ({
  getRunningAdapter: (...args: unknown[]) => mockGetRunningAdapter(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    connectorAudit: {
      where: () => ({
        between: () => ({
          last: () => Promise.resolve(undefined),
        }),
      }),
    },
    connectorHeartbeats: {
      put: (...args: unknown[]) => mockHeartbeatPut(...args),
    },
  })),
}))

jest.mock("@/lib/connectors/outbound-runner", () => ({
  isInQuietHours: jest.fn(() => false),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsHealth: jest.fn().mockResolvedValue({
    serverRunning: true,
    boundAddr: "127.0.0.1:8080",
    registeredAdapterCount: 1,
  }),
  connectorsKeyringGet: jest.fn().mockResolvedValue("token"),
}))

jest.mock("@/lib/connectors/adapters/lark/auth", () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue("fake-tat"),
}))

function makeRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "lark-test",
    type: "lark",
    displayName: "Lark Test",
    enabled: true,
    transportMode: "webhook",
    settings: { transport: "webhook" },
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: {} as never,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as AdapterInstanceRow
}

describe("isPassiveTransport", () => {
  it("returns true for OneBot rows", () => {
    expect(isPassiveTransport(makeRow({ type: "onebot", settings: {} }))).toBe(true)
  })

  it("returns true for Lark webhook rows", () => {
    expect(isPassiveTransport(makeRow({ type: "lark", settings: { transport: "webhook" } }))).toBe(
      true
    )
  })

  it("returns false for Lark long-connection rows", () => {
    expect(
      isPassiveTransport(makeRow({ type: "lark", settings: { transport: "long-connection" } }))
    ).toBe(false)
  })

  it("returns false for Telegram / Slack / Discord", () => {
    expect(isPassiveTransport(makeRow({ type: "telegram", settings: {} }))).toBe(false)
    expect(isPassiveTransport(makeRow({ type: "slack", settings: {} }))).toBe(false)
    expect(isPassiveTransport(makeRow({ type: "discord", settings: {} }))).toBe(false)
  })
})

describe("benefitsFromProbe", () => {
  it.each([
    ["discord", "gateway", {}],
    ["slack", "gateway", { transport: "socket-mode" }],
    ["qq-official", "gateway", {}],
    ["dingtalk", "gateway", {}],
  ])("includes %s gateway transports", (type, transportMode, settings) => {
    expect(
      benefitsFromProbe(
        makeRow({
          type: type as AdapterInstanceRow["type"],
          transportMode: transportMode as AdapterInstanceRow["transportMode"],
          settings,
        })
      )
    ).toBe(true)
  })

  it("excludes webhook variants of dual-transport gateway adapters", () => {
    expect(
      benefitsFromProbe(makeRow({ type: "discord", transportMode: "webhook", settings: {} }))
    ).toBe(false)
    expect(
      benefitsFromProbe(
        makeRow({
          type: "slack",
          transportMode: "webhook",
          settings: { transport: "events-api-webhook" },
        })
      )
    ).toBe(false)
  })
})

describe("deriveHeartbeat", () => {
  const row = makeRow()

  it("reports running when last inbound is within the idle threshold", async () => {
    const now = 1_000_000
    const derived = await deriveHeartbeat(row, {
      now,
      probeOverrides: {
        lastInboundAt: async () => now - 60_000, // 1 minute ago
      },
    })
    expect(derived.state).toBe("running")
    expect(derived.reason).toBeUndefined()
  })

  it("annotates quiet_hours_silent when idle but inside quiet window", async () => {
    const now = 1_000_000
    const quietRow = makeRow({
      quietHours: { from: "22:00", to: "07:00", tz: "Asia/Shanghai" },
    })
    const derived = await deriveHeartbeat(quietRow, {
      now,
      probeOverrides: {
        lastInboundAt: async () => now - 10 * 60_000, // 10 minutes ago
        isInQuietHours: () => true,
      },
    })
    expect(derived.state).toBe("running")
    expect(derived.reason).toBe("quiet_hours_silent")
  })

  it("idle Lark with successful ping is running/idle", async () => {
    const now = 1_000_000
    const derived = await deriveHeartbeat(row, {
      now,
      probeOverrides: {
        lastInboundAt: async () => now - 10 * 60_000,
        larkPing: async () => true,
      },
    })
    expect(derived.state).toBe("running")
    expect(derived.reason).toBe("idle")
    expect(derived.pingOk).toBe(true)
  })

  it("idle Lark with failed ping is degraded", async () => {
    const now = 1_000_000
    const derived = await deriveHeartbeat(row, {
      now,
      probeOverrides: {
        lastInboundAt: async () => now - 10 * 60_000,
        larkPing: async () => false,
      },
    })
    expect(derived.state).toBe("degraded")
    expect(derived.reason).toBe("lark_ping_failed")
    expect(derived.pingOk).toBe(false)
  })

  it("idle OneBot with no axum server is degraded", async () => {
    const now = 1_000_000
    const onebot = makeRow({ type: "onebot", settings: {} })
    const derived = await deriveHeartbeat(onebot, {
      now,
      probeOverrides: {
        lastInboundAt: async () => null,
        onebotPing: async () => false,
      },
    })
    expect(derived.state).toBe("degraded")
    expect(derived.reason).toBe("onebot_no_client")
  })

  it("idle gateway with a failed transport health probe is degraded", async () => {
    const gateway = makeRow({
      type: "discord",
      transportMode: "gateway",
      settings: {},
    })
    const derived = await deriveHeartbeat(gateway, {
      now: 1_000_000,
      probeOverrides: {
        lastInboundAt: async () => null,
        gatewayPing: async () => false,
      },
    })
    expect(derived).toEqual(
      expect.objectContaining({
        state: "degraded",
        reason: "gateway_probe_failed",
        pingOk: false,
      })
    )
  })

  it("never-received-inbound treats age as Infinity", async () => {
    const onebot = makeRow({ type: "onebot", settings: {} })
    const derived = await deriveHeartbeat(onebot, {
      now: 1_000_000,
      probeOverrides: {
        lastInboundAt: async () => null,
        onebotPing: async () => true,
      },
    })
    expect(derived.state).toBe("running")
    expect(derived.reason).toBe("idle")
  })
})

describe("recordPassiveProbe", () => {
  it("writes one adapter.heartbeat row with the derived state + source", async () => {
    mockHeartbeatPut.mockClear()
    const row = makeRow({ type: "lark", settings: { transport: "webhook" } })
    // now = 1_000_000_000 (1B ms past epoch) so lastInboundAt below is
    // strictly less than now, giving a clean positive ageMs that is
    // still under the 5 min idle threshold for the early-return path.
    await recordPassiveProbe(row, 1_000_000_000, 5 * 60_000, {
      lastInboundAt: async () => 999_999_900, // 100 ms ago
      larkPing: async () => true,
    })
    expect(mockHeartbeatPut).toHaveBeenCalledTimes(1)
    const call = mockHeartbeatPut.mock.calls[0][0] as {
      adapterId: string
      kind: string
      fields: { source: string; state: string }
    }
    expect(call.adapterId).toBe("lark-test")
    expect(call.kind).toBe("adapter.heartbeat")
    expect(call.fields.source).toBe("passive_probe")
    expect(call.fields.state).toBe("running")
  })

  it("writes degraded with derived reason when ping fails on idle", async () => {
    mockHeartbeatPut.mockClear()
    const row = makeRow({ type: "lark", settings: { transport: "webhook" } })
    await recordPassiveProbe(row, 1_000_000_000, 5 * 60_000, {
      lastInboundAt: async () => 1_000_000_000 - 10 * 60_000, // 10 min ago
      larkPing: async () => false,
      isInQuietHours: () => false,
    })
    expect(mockHeartbeatPut).toHaveBeenCalledTimes(1)
    const call = mockHeartbeatPut.mock.calls[0][0] as {
      fields: { state: string; reason: string }
    }
    expect(call.fields.state).toBe("degraded")
    expect(call.fields.reason).toBe("lark_ping_failed")
  })
})

describe("OneBot transport-specific idle health", () => {
  const forward = makeRow({
    id: "onebot-forward",
    type: "onebot",
    transportMode: "forward-ws",
    settings: {},
  })
  beforeEach(() => {
    mockGetRunningAdapter.mockReset()
    jest.mocked(connectorsHealth).mockClear()
    jest
      .mocked(connectorsHealth)
      .mockResolvedValue({ serverRunning: false, boundAddr: null, registeredAdapterCount: 0 })
  })

  it("keeps a live forward socket healthy without an inbound axum server", async () => {
    mockGetRunningAdapter.mockReturnValue({ adapter: { health: () => ({ state: "running" }) } })
    expect(await deriveHeartbeat(forward, { now: 1_000_000 })).toMatchObject({
      state: "running",
      reason: "idle",
      pingOk: true,
    })
    expect(connectorsHealth).not.toHaveBeenCalled()
  })

  it.each(["degraded", "down"])(
    "does not mask a %s forward transport with another server's health",
    async (state) => {
      jest.mocked(connectorsHealth).mockResolvedValue({
        serverRunning: true,
        boundAddr: "127.0.0.1:8080",
        registeredAdapterCount: 1,
      })
      mockGetRunningAdapter.mockReturnValue({ adapter: { health: () => ({ state }) } })
      expect(await deriveHeartbeat(forward, { now: 1_000_000 })).toMatchObject({
        state: "degraded",
        pingOk: false,
      })
      expect(connectorsHealth).not.toHaveBeenCalled()
    }
  )

  it("treats an absent forward runtime as unhealthy", async () => {
    jest.mocked(connectorsHealth).mockResolvedValue({
      serverRunning: true,
      boundAddr: "127.0.0.1:8080",
      registeredAdapterCount: 1,
    })
    expect(await deriveHeartbeat(forward, { now: 1_000_000 })).toMatchObject({
      state: "degraded",
      pingOk: false,
    })
  })

  it("retains the native server probe for reverse and legacy default rows", async () => {
    jest.mocked(connectorsHealth).mockResolvedValue({
      serverRunning: true,
      boundAddr: "127.0.0.1:8080",
      registeredAdapterCount: 1,
    })
    for (const transportMode of ["reverse-ws", undefined] as const) {
      const legacyRow = { ...forward }
      if (transportMode === undefined) Reflect.deleteProperty(legacyRow, "transportMode")
      else legacyRow.transportMode = transportMode
      expect(await deriveHeartbeat(legacyRow, { now: 1_000_000 })).toMatchObject({
        state: "running",
        pingOk: true,
      })
    }
    expect(connectorsHealth).toHaveBeenCalledTimes(2)
    expect(mockGetRunningAdapter).not.toHaveBeenCalled()
  })

  it("does not requeue a healthy idle forward adapter on repeated real sweep probes", async () => {
    const adapter = {
      id: forward.id,
      health: () => ({ state: "running" as const }),
    } as PlatformAdapter
    mockGetRunningAdapter.mockReturnValue({ adapter })
    const requeue = jest.fn().mockResolvedValue(true)
    let tick: () => void = () => undefined
    const handle = startHeartbeatSweep({
      listAdapters: () => [{ adapter }],
      recordHeartbeat: async () => undefined,
      loadRows: async () => [forward],
      requeue,
      auditReconnect: jest.fn(),
      now: () => 1_000_000,
      scheduler: {
        setInterval: (callback) => {
          tick = callback
          return 1
        },
        clearInterval: () => undefined,
      },
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      tick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      tick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(requeue).not.toHaveBeenCalled()
      expect(mockGetRunningAdapter).toHaveBeenCalledTimes(2)
    } finally {
      handle.dispose()
    }
  })
})
