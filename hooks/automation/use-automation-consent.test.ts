/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useAutomationConsent } from "./use-automation-consent"
import type { ConsentRequestEvent } from "@/lib/automation/client"
import { desktop } from "@/lib/automation/client"
import { transport } from "@/lib/tauri"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  __resetConsentRouting,
  claimConsentSurface,
  markConsentSettled,
} from "@/lib/automation/consent-routing"

let handler: ((payload: ConsentRequestEvent) => void) | null = null
const unsubMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    subscribe: (event: string, h: (p: ConsentRequestEvent) => void) => {
      if (event === "automation:consent-request") handler = h
      return unsubMock
    },
    whenSubscribed: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({ onTransportChange: jest.fn(() => () => {}) }))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: jest.fn(() => null),
  subscribeActiveRemoteTransport: jest.fn(() => () => {}),
}))

const consentRespondMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/automation/client", () => ({
  desktop: {
    consentRespond: (...a: unknown[]) => consentRespondMock(...a),
    consentPending: jest.fn().mockResolvedValue([]),
  },
}))

const pendingMock = jest.mocked(desktop.consentPending)
const readyMock = jest.mocked(transport.whenSubscribed!)

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
  __resetConsentRouting()
  handler = null
  unsubMock.mockClear()
  consentRespondMock.mockClear().mockResolvedValue(undefined)
  pendingMock.mockReset().mockResolvedValue([])
  readyMock.mockReset().mockResolvedValue(undefined)
  jest.mocked(getActiveRemoteTransport).mockReturnValue(null)
  jest
    .mocked(subscribeActiveRemoteTransport)
    .mockReset()
    .mockReturnValue(() => {})
})

describe("useAutomationConsent", () => {
  it("does not subscribe when disabled", () => {
    renderHook(() => useAutomationConsent({ enabled: false }))
    expect(handler).toBeNull()
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it("enqueues an incoming consent-request frame", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt()))
    expect(result.current.queue).toHaveLength(1)
    expect(result.current.queue[0].id).toBe("evt-1")
  })

  it("starts a new prompt countdown at receipt after an idle period", () => {
    const nowMock = jest.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
      nowMock.mockReturnValue(91_000)
      act(() => handler!(evt({ timeoutMs: 5_000 })))
      expect(result.current.now).toBe(91_000)
      expect(result.current.queue[0].expiresAt).toBe(96_000)
      expect(result.current.queue[0].expiresAt - result.current.now).toBe(5_000)
    } finally {
      nowMock.mockRestore()
    }
  })

  it("recovers the first missed prompt only after the listener is registered", async () => {
    let release!: () => void
    readyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    pendingMock.mockResolvedValue([evt({ id: "before-listen", timeoutMs: 4_000 })])
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    expect(pendingMock).not.toHaveBeenCalled()
    await act(async () => {
      release()
    })
    expect(readyMock).toHaveBeenCalledWith(["automation:consent-request"])
    expect(result.current.queue.map((p) => p.id)).toEqual(["before-listen"])
  })

  it("does not resurrect an answered live prompt from an in-flight snapshot", async () => {
    let resolvePending!: (events: ConsentRequestEvent[]) => void
    pendingMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve
      })
    )
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await act(async () => {})
    act(() => handler!(evt()))
    await act(async () => {
      await result.current.respond(result.current.queue[0], false, false)
    })
    await act(async () => {
      resolvePending([evt()])
    })
    expect(result.current.queue).toEqual([])
  })

  it("never extends a live deadline when the backfill reports less remaining time", async () => {
    const nowMock = jest.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      let resolvePending!: (events: ConsentRequestEvent[]) => void
      pendingMock.mockReturnValue(
        new Promise((resolve) => {
          resolvePending = resolve
        })
      )
      const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
      await act(async () => {})
      act(() => handler!(evt({ timeoutMs: 30_000 })))
      nowMock.mockReturnValue(5_000)
      await act(async () => {
        resolvePending([evt({ timeoutMs: 7_000 })])
      })
      expect(result.current.queue).toHaveLength(1)
      expect(result.current.queue[0].expiresAt).toBe(8_000)
      expect(result.current.now).toBe(5_000)
    } finally {
      nowMock.mockRestore()
    }
  })

  it("drops backfilled prompts whose remaining budget was spent in transit", async () => {
    const nowMock = jest.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      let resolvePending!: (events: ConsentRequestEvent[]) => void
      pendingMock.mockReturnValue(
        new Promise((resolve) => {
          resolvePending = resolve
        })
      )
      const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
      await act(async () => {})
      nowMock.mockReturnValue(5_000)
      await act(async () => {
        resolvePending([evt({ timeoutMs: 3_000 })])
      })
      expect(result.current.queue).toEqual([])
    } finally {
      nowMock.mockRestore()
    }
  })

  it("ignores delayed recovery after unmount", async () => {
    let release!: () => void
    readyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const { unmount } = renderHook(() => useAutomationConsent({ enabled: true }))
    unmount()
    await act(async () => {
      release()
    })
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it("keeps the live stream working when the pending snapshot fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      pendingMock.mockRejectedValue(new Error("offline"))
      const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
      await act(async () => {})
      act(() => handler!(evt()))
      expect(result.current.queue).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith("automation_consent_pending failed", expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it("ignores an old host's delayed snapshot and live callback", async () => {
    let notify!: () => void
    let resolvePending!: (events: ConsentRequestEvent[]) => void
    pendingMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePending = resolve
      })
    )
    jest.mocked(subscribeActiveRemoteTransport).mockImplementation((listener) => {
      notify = () => listener(null)
      return () => {}
    })
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await act(async () => {})
    const oldHandler = handler!
    act(() => {
      jest.mocked(getActiveRemoteTransport).mockReturnValue({ ...transport })
      notify()
    })
    await act(async () => {
      resolvePending([evt({ id: "old-snapshot" })])
    })
    act(() => oldHandler(evt({ id: "old-event" })))
    expect(result.current.queue).toEqual([])
    act(() => handler!(evt({ id: "current" })))
    expect(result.current.queue.map((p) => p.id)).toEqual(["current"])
  })

  it("hides the old host queue and refuses its stale response after switching hosts", async () => {
    let notify!: () => void
    jest.mocked(subscribeActiveRemoteTransport).mockImplementation((listener) => {
      notify = () => listener(null)
      return () => {}
    })
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await act(async () => {})
    act(() => handler!(evt()))
    const previousPrompt = result.current.queue[0]
    const previousRespond = result.current.respond
    act(() => {
      jest.mocked(getActiveRemoteTransport).mockReturnValue({ ...transport })
      notify()
    })
    expect(result.current.queue).toEqual([])
    await act(async () => {
      await previousRespond(previousPrompt, true, false)
    })
    expect(consentRespondMock).not.toHaveBeenCalled()
  })

  it("dedupes a replayed frame by id", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt()))
    act(() => handler!(evt()))
    expect(result.current.queue).toHaveLength(1)
  })

  it("respond(allow, persist) echoes the session-scoped prompt and grant duration", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt({ pluginId: "cu", sessionKey: "chat-42" })))
    await act(async () => {
      await result.current.respond(result.current.queue[0], true, true, 15 * 60 * 1000)
    })
    expect(consentRespondMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "evt-1",
        allow: true,
        persist: true,
        grantDurationMs: 15 * 60 * 1000,
        prompt: expect.objectContaining({
          command: "click",
          surface: "computerUse",
          pluginId: "cu",
          sessionKey: "chat-42",
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
      expect.objectContaining({
        id: "evt-1",
        allow: false,
        persist: false,
        grantDurationMs: undefined,
        prompt: undefined,
      })
    )
  })

  it("normalizes a missing session key to null in a persisted prompt", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => handler!(evt({ sessionKey: undefined })))

    await act(async () => {
      await result.current.respond(result.current.queue[0], true, true)
    })

    expect(consentRespondMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.objectContaining({ sessionKey: null }),
      })
    )
  })

  it("hides prompts another window claimed or answered, only when asked to", async () => {
    const routed = renderHook(() => useAutomationConsent({ enabled: true, honorRouting: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => {
      handler!(evt({ id: "copilot", surface: "chatCopilot" }))
      handler!(evt({ id: "agent" }))
    })
    expect(routed.result.current.queue.map((p) => p.id)).toEqual(["copilot", "agent"])

    let release = () => {}
    act(() => {
      release = claimConsentSurface("chatCopilot")
    })
    expect(routed.result.current.queue.map((p) => p.id)).toEqual(["agent"])

    act(() => markConsentSettled("agent"))
    expect(routed.result.current.queue).toEqual([])

    // Released unanswered: the copilot prompt comes back rather than vanishing.
    act(() => release())
    expect(routed.result.current.queue.map((p) => p.id)).toEqual(["copilot"])
  })

  it("shows every prompt when routing is not honored", async () => {
    const { result } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    act(() => {
      claimConsentSurface("chatCopilot")
      handler!(evt({ id: "copilot", surface: "chatCopilot" }))
    })
    expect(result.current.queue.map((p) => p.id)).toEqual(["copilot"])
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useAutomationConsent({ enabled: true }))
    await waitFor(() => expect(handler).toBeTruthy())
    unmount()
    expect(unsubMock).toHaveBeenCalled()
  })
})
