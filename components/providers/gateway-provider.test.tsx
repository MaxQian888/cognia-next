import { render, act } from "@testing-library/react"
import { GatewayProvider } from "./gateway-provider"

const mockGetStatus = jest.fn()
const mockPushSnapshot = jest.fn()
let mockSubscribeHandler: ((p: unknown) => void) | null = null
const mockUnsubscribe = jest.fn()
let tauri = true

jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: {
    subscribe: (_event: string, handler: (p: unknown) => void) => {
      mockSubscribeHandler = handler
      return mockUnsubscribe
    },
  },
}))

jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: (...a: unknown[]) => mockGetStatus(...a),
  gatewayPushSnapshot: (...a: unknown[]) => mockPushSnapshot(...a),
}))

const mockForward = jest.fn()
jest.mock("@/lib/gateway/telemetry-forwarder", () => ({
  forwardGatewayOutcome: (...a: unknown[]) => mockForward(...a),
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
    mockSubscribeHandler = null
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
    expect(mockSubscribeHandler).toBeTruthy()
    act(() => {
      mockSubscribeHandler?.({ providerId: "openai", modelId: "gpt-4o", ok: true, latencyMs: 1 })
    })
    expect(mockForward).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai" }))
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
