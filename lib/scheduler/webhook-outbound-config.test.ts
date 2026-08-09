/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"
import { getWebhookOutboundConfig, useWebhookSigningState } from "./webhook-outbound-config"
import { useWebhookStore } from "@/stores/webhooks/store"
import { DEFAULT_WEBHOOK_DELIVERY } from "@/types/webhooks"

jest.mock("@/lib/webhooks/signing-secret", () => ({
  getWebhookSigningSecret: jest.fn(),
  setWebhookSigningSecret: jest.fn(),
}))

const { getWebhookSigningSecret: mockedGetSecret } = jest.requireMock(
  "@/lib/webhooks/signing-secret"
) as { getWebhookSigningSecret: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
  mockedGetSecret.mockResolvedValue(null)
  useWebhookStore.getState().reset()
})

describe("getWebhookOutboundConfig", () => {
  it("returns defaults when no headers or secret are configured", async () => {
    const config = await getWebhookOutboundConfig()
    expect(config.headers).toBeUndefined()
    expect(config.signingSecret).toBeUndefined()
    expect(config.delivery).toEqual(DEFAULT_WEBHOOK_DELIVERY)
  })

  it("merges store-configured headers into the resolved config", async () => {
    useWebhookStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        defaultHeaders: [
          { name: "X-Foo", value: "bar" },
          { name: "  ", value: "ignored" },
          { name: "X-Bar", value: "baz" },
        ],
      },
    }))
    const config = await getWebhookOutboundConfig()
    expect(config.headers).toEqual({ "X-Foo": "bar", "X-Bar": "baz" })
  })

  it("reads the signing secret from shared secure storage", async () => {
    mockedGetSecret.mockResolvedValue("super-secret")
    const config = await getWebhookOutboundConfig()
    expect(mockedGetSecret).toHaveBeenCalled()
    expect(config.signingSecret).toBe("super-secret")
  })

  it("fails closed when configured signing cannot be read", async () => {
    useWebhookStore.setState((state) => ({
      config: { ...state.config, hasSigningSecret: true },
    }))
    mockedGetSecret.mockRejectedValue(new Error("keyring offline"))

    await expect(getWebhookOutboundConfig()).rejects.toThrow("keyring offline")
  })

  it("treats secure-storage errors as no secret", async () => {
    mockedGetSecret.mockRejectedValue(new Error("keyring offline"))
    await expect(getWebhookOutboundConfig()).resolves.toMatchObject({ signingSecret: undefined })
  })

  it("treats webhook store errors as no extra headers", async () => {
    const original = useWebhookStore.getState
    useWebhookStore.getState = (() => {
      throw new Error("store not initialised")
    }) as typeof useWebhookStore.getState
    try {
      await expect(getWebhookOutboundConfig()).resolves.toMatchObject({ headers: undefined })
    } finally {
      useWebhookStore.getState = original
    }
  })
})

describe("useWebhookSigningState", () => {
  it("resolves to disabled when secure storage has no secret", async () => {
    const { result } = renderHook(() => useWebhookSigningState())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.enabled).toBe(false)
  })

  it("resolves to enabled when secure storage exposes a non-empty secret", async () => {
    mockedGetSecret.mockResolvedValue("hunter2")
    const { result } = renderHook(() => useWebhookSigningState())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.enabled).toBe(true)
  })

  it("does not update state after unmount", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
