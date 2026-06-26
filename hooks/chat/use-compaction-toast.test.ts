/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

const toastMock = jest.fn()
jest.mock("sonner", () => ({ toast: (msg: string, opts?: unknown) => toastMock(msg, opts) }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

let showSetting = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { compaction: { showCompressionNotification: showSetting } } }),
}))

import { useCompactionToast } from "./use-compaction-toast"

function boundary(id: string, preTokens?: number, postTokens?: number): UIMessage {
  return {
    id,
    role: "system",
    parts: [{ type: "compact-boundary", preTokens, postTokens }],
  } as unknown as UIMessage
}

function userMsg(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: "hi" }] } as unknown as UIMessage
}

beforeEach(() => {
  toastMock.mockClear()
  showSetting = true
})

describe("useCompactionToast", () => {
  it("primes existing boundaries without toasting on first render", () => {
    renderHook(({ messages }) => useCompactionToast(messages), {
      initialProps: { messages: [userMsg("u1"), boundary("b1", 45000, 8000)] },
    })
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("toasts once when a new boundary appears, with the token detail", () => {
    const { rerender } = renderHook(({ messages }) => useCompactionToast(messages), {
      initialProps: { messages: [userMsg("u1")] },
    })
    expect(toastMock).not.toHaveBeenCalled()

    rerender({ messages: [userMsg("u1"), boundary("b1", 45000, 8000)] })
    expect(toastMock).toHaveBeenCalledTimes(1)
    const [msg, opts] = toastMock.mock.calls[0]
    expect(msg).toBe("notification")
    expect((opts as { description: string }).description).toContain("notificationDetail")

    // No re-toast on a re-render with the same messages.
    rerender({ messages: [userMsg("u1"), boundary("b1", 45000, 8000)] })
    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  it("omits the description when token figures are missing", () => {
    const { rerender } = renderHook(({ messages }) => useCompactionToast(messages), {
      initialProps: { messages: [] as UIMessage[] },
    })
    rerender({ messages: [boundary("b1")] })
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock.mock.calls[0][1]).toBeUndefined()
  })

  it("does not toast when showCompressionNotification is off", () => {
    showSetting = false
    const { rerender } = renderHook(({ messages }) => useCompactionToast(messages), {
      initialProps: { messages: [] as UIMessage[] },
    })
    rerender({ messages: [boundary("b1", 1, 2)] })
    expect(toastMock).not.toHaveBeenCalled()
  })
})
