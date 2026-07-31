import { render, act } from "@testing-library/react"
import { GatewayProvider } from "./gateway-provider"

const mockGetStatus = jest.fn()
const mockPushSnapshot = jest.fn()
const mockDecisionResponse = jest.fn()
const handlers: Record<string, (p: unknown) => void> = {}
const mockUnsubscribe = jest.fn()
let tauri = true

jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: {
    subscribe: (event: string, handler: (p: unknown) => void) => {
      handlers[event] = handler
      return mockUnsubscribe
    },
  },
}))

jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: (...a: unknown[]) => mockGetStatus(...a),
  gatewayPushSnapshot: (...a: unknown[]) => mockPushSnapshot(...a),
  gatewayDecisionResponse: (...a: unknown[]) => mockDecisionResponse(...a),
}))

const mockForward = jest.fn()
jest.mock("@/lib/gateway/telemetry-forwarder", () => ({
  forwardGatewayOutcome: (...a: unknown[]) => mockForward(...a),
}))

const mockAppendLog = jest.fn()
jest.mock("@/lib/db/gateway-request-log", () => ({
  appendGatewayRequestLog: (...a: unknown[]) => mockAppendLog(...a),
}))

const mockResolveDecision = jest.fn(async (..._args: unknown[]) => [])
jest.mock("@/lib/gateway/decide", () => ({
  resolveGatewayDecision: (...args: unknown[]) => mockResolveDecision(...args),
}))

// Subscription enrich is a no-op pass-through in these tests (returns the
// base snapshot); the resolver itself is covered in snapshot-publisher.test.
jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: jest.fn().mockResolvedValue(null),
}))

// The profile-meta join reads Dexie, which never settles under fake timers —
// stub the accessor layer (its own behavior is covered in
// lib/db/provider-profiles.test.ts). `undefined` meta = legacy push shape.
jest.mock("@/lib/db/provider-profiles", () => ({
  getProfileMeta: jest.fn().mockResolvedValue(undefined),
  listDeploymentProfiles: jest.fn().mockResolvedValue([]),
  listTransportProfiles: jest.fn().mockResolvedValue([]),
}))

// Stubbed so the deps `overrides` the provider assembles can be inspected. The
// stub engine's `selectProvider` returns undefined, which `resolveGatewayDecision`
// maps to `[]` — the same answer the real engine gives for an unmatched alias.
type EngineOverrides = { getInFlight: (id: string) => number }

// Args are declared so `mock.calls[…][1]` is typed as the overrides object.
const mockBuildEngine = jest.fn((_settings: unknown, _overrides?: EngineOverrides) => ({
  selectProvider: () => undefined,
}))
/** Chat-plane in-flight, as the renderer's own store would report it. */
const mockBuildDeps = jest.fn((_settings: unknown) => ({
  getInFlight: (id: string) => (id === "openai" ? 2 : 0),
}))
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  // Referenced lazily inside the arrows — a direct reference in the factory
  // body would hit the hoisted-mock TDZ.
  buildRoutingEngine: (settings: unknown, overrides?: EngineOverrides) =>
    mockBuildEngine(settings, overrides),
  buildRoutingEngineDeps: (settings: unknown) => mockBuildDeps(settings),
}))

/** Drive the decide round-trip and hand back the deps overrides it built. */
async function decideWith(payload: Record<string, unknown>) {
  await act(async () => {
    handlers["gateway://decide"](payload)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return mockBuildEngine.mock.calls.at(-1)?.[1]
}

const settingsState = {
  settings: {
    defaultProvider: "openai",
    providerSettings: { openai: { providerId: "openai", apiKey: "k", enabled: true } },
    customProviders: [],
    modelMappings: [],
    autoRouting: { dataPolicy: "local-only" },
  },
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign((selector: (s: unknown) => unknown) => selector(settingsState), {
    getState: () => settingsState,
  }),
}))

describe("GatewayProvider", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    tauri = true
    mockGetStatus.mockReset().mockResolvedValue({ hasToken: true })
    mockPushSnapshot.mockReset().mockResolvedValue(undefined)
    mockForward.mockReset()
    mockUnsubscribe.mockReset()
    mockAppendLog.mockReset().mockResolvedValue(undefined)
    mockDecisionResponse.mockReset().mockResolvedValue(undefined)
    // `decideWith` reads `mock.calls.at(-1)`, so a stale call from a previous
    // test would be read as this one's.
    mockBuildEngine.mockClear()
    mockBuildDeps.mockClear()
    mockResolveDecision.mockClear()
    for (const k of Object.keys(handlers)) delete handlers[k]
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it("pushes the snapshot (debounced) when a token exists", async () => {
    render(<GatewayProvider />)
    expect(mockPushSnapshot).not.toHaveBeenCalled() // debounced
    await act(async () => {
      jest.advanceTimersByTime(1500)
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalled()
    expect(mockPushSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ providers: expect.any(Array), aliases: expect.any(Array) })
    )
  })

  it("does not push when the gateway has no token", async () => {
    mockGetStatus.mockResolvedValue({ hasToken: false })
    render(<GatewayProvider />)
    await act(async () => {
      jest.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(mockPushSnapshot).not.toHaveBeenCalled()
  })

  it("forwards request-outcome events into telemetry", () => {
    render(<GatewayProvider />)
    expect(handlers["gateway://request-outcome"]).toBeTruthy()
    act(() => {
      handlers["gateway://request-outcome"]({
        providerId: "openai",
        modelId: "gpt-4o",
        ok: true,
        latencyMs: 1,
      })
    })
    expect(mockForward).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai" }))
  })

  it("persists request-log events into Dexie", () => {
    render(<GatewayProvider />)
    expect(handlers["gateway://request-log"]).toBeTruthy()
    const row = {
      id: "log-1",
      at: "2026-07-03T00:00:00Z",
      route: "/v1/chat/completions",
      remoteIp: "127.0.0.1",
      keyId: "k1",
      model: "fast",
      providerId: "groq",
      status: 200,
      latencyMs: 12,
      inputTokens: 3,
      outputTokens: 5,
      error: null,
      stream: false,
    }
    act(() => {
      handlers["gateway://request-log"](row)
    })
    expect(mockAppendLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log-1", status: 200 })
    )
  })

  it("answers a gateway://decide request via gatewayDecisionResponse", async () => {
    render(<GatewayProvider />)
    expect(handlers["gateway://decide"]).toBeTruthy()
    await act(async () => {
      handlers["gateway://decide"]({ requestId: "r1", model: "no-such-alias" })
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await Promise.resolve()
    })
    // No alias matches → empty entries (gateway falls back to its snapshot),
    // but the round-trip is always answered so the Rust side doesn't wait out
    // the full timeout.
    expect(mockDecisionResponse).toHaveBeenCalledWith("r1", [])
  })

  it("folds the gateway's own in-flight counts into the least-busy signal", async () => {
    // The renderer's in-flight store is written only by the chat plane, so
    // without this merge a burst of concurrent gateway requests all score every
    // provider as idle and pile onto one deployment.
    render(<GatewayProvider />)
    const overrides = await decideWith({
      requestId: "r2",
      model: "some-alias",
      inFlight: { openai: 3 },
    })
    expect(overrides?.getInFlight("openai")).toBe(5) // 2 chat-plane + 3 gateway
    expect(overrides?.getInFlight("anthropic")).toBe(0)
  })

  it("falls back to the chat-plane count when the gateway sends no in-flight map", async () => {
    render(<GatewayProvider />)
    const overrides = await decideWith({ requestId: "r3", model: "some-alias" })
    expect(overrides?.getInFlight("openai")).toBe(2)
  })

  it("passes the live auto-routing data policy into the decision resolver", async () => {
    render(<GatewayProvider />)
    await decideWith({ requestId: "r-policy", model: "some-alias" })
    expect(mockResolveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "r-policy" }),
      expect.any(Object),
      undefined,
      "local-only"
    )
  })

  it("is inert outside Tauri", () => {
    tauri = false
    render(<GatewayProvider />)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(mockPushSnapshot).not.toHaveBeenCalled()
    expect(mockUnsubscribe).not.toHaveBeenCalled()
  })

  it("detaches the telemetry subscription on unmount", () => {
    const { unmount } = render(<GatewayProvider />)
    unmount()
    expect(mockUnsubscribe).toHaveBeenCalled()
  })
})
