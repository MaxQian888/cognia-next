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

// Subscription enrich is a no-op pass-through in these tests (returns the
// base snapshot); the resolver itself is covered in snapshot-publisher.test.
jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: jest.fn().mockResolvedValue(null),
}))

const settingsState = {
  settings: {
    defaultProvider: "openai",
    providerSettings: { openai: { providerId: "openai", apiKey: "k", enabled: true } },
    customProviders: [],
    modelMappings: [],
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
      await Promise.resolve()
      await Promise.resolve()
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
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // No alias matches → empty entries (gateway falls back to its snapshot),
    // but the round-trip is always answered so the Rust side doesn't wait out
    // the full timeout.
    expect(mockDecisionResponse).toHaveBeenCalledWith("r1", [])
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
