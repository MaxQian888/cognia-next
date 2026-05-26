/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useAutomationConsent } from "./use-automation-consent"
import type { ConsentRequestEvent } from "@/lib/automation/client"

let handler: ((payload: ConsentRequestEvent) => void) | null = null
const unsubMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    subscribe: (event: string, h: (p: ConsentRequestEvent) => void) => {
      if (event === "automation:consent-request") handler = h
      return unsubMock
    },
  },
}))

const consentRespondMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/automation/client", () => ({
  desktop: { consentRespond: (...a: unknown[]) => consentRespondMock(...a) },
}))

function evt(overrides: Partial<ConsentRequestEvent> = {}): ConsentRequestEvent {
  return {
    id: "evt-1",
    command: "click",
    surface: "computerUse",
    pluginId: null,
    processName: null,
    windowTitle: null,
    timeoutMs: 30000,
    ...overrides,
  } as ConsentRequestEvent
}

beforeEach(() => {
  handler = null
  unsubMock.mockClear()
  consentRespondMock.mockClear().mockResolvedValue(undefined)
})

describe("useAutomationConsent", () => {
  it("does not subscribe when disabled", () => {
    renderHook(() => useAutomationConsent({ enabled: false }))
    expect(handler).toBeNull()
  })

  it("enqueues an incoming consent-request frame", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt()))
    expect(result.current.queue).toHaveLength(1)
    expect(result.current.queue[0].id).toBe("evt-1")
  })

  it("dedupes a replayed frame by id", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt()))
    act(() => handler!(evt()))
    expect(result.current.queue).toHaveLength(1)
  })

  it("respond(allow, persist) echoes the prompt back and dequeues", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt({ pluginId: "cu" })))
    await act(async () => {
      await result.current.respond(result.current.queue[0], true, true)
    })
    expect(consentRespondMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "evt-1",
        allow: true,
        persist: true,
        prompt: expect.objectContaining({
          command: "click",
          surface: "computerUse",
          pluginId: "cu",
        }),
      })
    )
    expect(result.current.queue).toHaveLength(0)
  })

  it("respond(reject) sends allow=false and omits the prompt", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt()))
    await act(async () => {
      await result.current.respond(result.current.queue[0], false, false)
    })
    expect(consentRespondMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-1", allow: false, persist: false, prompt: undefined })
    )
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    unmount()
    expect(unsubMock).toHaveBeenCalled()
  })
})
