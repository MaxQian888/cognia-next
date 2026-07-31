/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"
import { getWebhookOutboundConfig, useWebhookSigningState } from "./webhook-outbound-config"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { DEFAULT_WEBHOOK_DELIVERY } from "@/types/remote-control"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlGetSigningSecret: jest.fn(),
}))

const { isTauri: mockedIsTauri } = jest.requireMock("@/lib/tauri") as {
  isTauri: jest.Mock
}
const { remoteControlGetSigningSecret: mockedGetSecret } = jest.requireMock(
  "@/lib/tauri/remote-control"
) as { remoteControlGetSigningSecret: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
  // Reset the remote-control store between tests so headers don't leak
  // across cases.
  useRemoteControlStore.setState((s) => ({
    ...s,
    config: {
      ...s.config,
      outbound: { ...s.config.outbound, defaultHeaders: [] },
    },
  }))
})

describe("getWebhookOutboundConfig", () => {
  it("returns no headers and no secret on web (delivery falls back to defaults)", async () => {
    mockedIsTauri.mockReturnValue(false)
    const config = await getWebhookOutboundConfig()
    expect(config.headers).toBeUndefined()
    expect(config.signingSecret).toBeUndefined()
    expect(config.delivery).toEqual(DEFAULT_WEBHOOK_DELIVERY)
  })

  it("merges store-configured headers into the resolved config", async () => {
    mockedIsTauri.mockReturnValue(false)
    useRemoteControlStore.setState((s) => ({
      ...s,
      config: {
        ...s.config,
        outbound: {
          ...s.config.outbound,
          defaultHeaders: [
            { name: "X-Foo", value: "bar" },
            { name: "  ", value: "ignored" }, // empty name should be skipped
            { name: "X-Bar", value: "baz" },
          ],
        },
      },
    }))
    const config = await getWebhookOutboundConfig()
    expect(config.headers).toEqual({ "X-Foo": "bar", "X-Bar": "baz" })
    expect(config.signingSecret).toBeUndefined()
  })

  it("reads the signing secret from the keyring on desktop", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSecret.mockResolvedValue("super-secret")
    const config = await getWebhookOutboundConfig()
    expect(mockedGetSecret).toHaveBeenCalled()
    expect(config.signingSecret).toBe("super-secret")
  })

  it("treats keyring errors as 'no secret set'", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSecret.mockRejectedValue(new Error("keyring offline"))
    const config = await getWebhookOutboundConfig()
    expect(config.signingSecret).toBeUndefined()
  })

  it("treats remote-control store errors as no extra headers", async () => {
    mockedIsTauri.mockReturnValue(false)
    const original = useRemoteControlStore.getState
    // Force getState to throw to simulate an uninitialised store.
    useRemoteControlStore.getState = (() => {
      throw new Error("store not initialised")
    }) as typeof useRemoteControlStore.getState
    try {
      const config = await getWebhookOutboundConfig()
      expect(config.headers).toBeUndefined()
    } finally {
      useRemoteControlStore.getState = original
    }
  })
})

describe("useWebhookSigningState", () => {
  it("resolves to disabled on web", async () => {
    mockedIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useWebhookSigningState())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.enabled).toBe(false)
  })

  it("resolves to enabled when the keyring exposes a non-empty secret", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSecret.mockResolvedValue("hunter2")
    const { result } = renderHook(() => useWebhookSigningState())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.enabled).toBe(true)
  })

  it("resolves to disabled when the keyring returns empty", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSecret.mockResolvedValue("")
    const { result } = renderHook(() => useWebhookSigningState())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.enabled).toBe(false)
  })

  it("does not call setState after unmount (no act warnings)", async () => {
    mockedIsTauri.mockReturnValue(true)
    let resolveSecret: ((value: string) => void) | undefined
    mockedGetSecret.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSecret = resolve
      })
    )
    const { result, unmount } = renderHook(() => useWebhookSigningState())
    expect(result.current.loading).toBe(true)
    unmount()
    resolveSecret?.("late-secret")
    // No assertion required — the test passes if no act warning is logged.
    await new Promise((r) => setTimeout(r, 10))
  })
})
