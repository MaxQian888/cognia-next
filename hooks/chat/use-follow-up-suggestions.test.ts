import { act, renderHook, waitFor } from "@testing-library/react"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { useFollowUpSuggestions } from "./use-follow-up-suggestions"

type Msg = { id: string; role: string; parts: unknown }
type NativePrediction = {
  turnId: string
  requestedAt: number
  userMessageId: string | null
  text: string | null
  contextKey?: string
  branchKey?: string
}
function nativeContextKey(messages: Msg[]) {
  return JSON.stringify(
    messages.slice(-6).map((message) => [message.id, message.role, message.parts])
  )
}
const mockChatState: {
  messages: Msg[]
  status: string
  sessions: Record<
    string,
    {
      messages: Msg[]
      status: string
      promptPrediction?: NativePrediction
      activeBranchByGroup?: Record<string, string>
    }
  >
} = { messages: [], status: "idle", sessions: {} }
const settingsState: { settings: Record<string, unknown> } = {
  settings: { composerAssistance: { suggestions: { followUps: true } } },
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  promptPredictionContextKey: (messages: Msg[]) => nativeContextKey(messages),
  useSessionVisibleMessages: (id: string) =>
    mockChatState.sessions[id]?.messages ?? mockChatState.messages,
  useSessionStatus: (id: string) => mockChatState.sessions[id]?.status ?? mockChatState.status,
  useChatStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockChatState), {
    getState: () => mockChatState,
  }),
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))

const mockHeadless = jest.fn()
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({
  buildHeadlessTurnLlmClient: (...a: unknown[]) => mockHeadless(...a),
}))

const mockSuggest = jest.fn()
jest.mock("@/lib/chat/completion/suggestions", () => ({
  suggestFollowUps: (...a: unknown[]) => mockSuggest(...a),
}))

let session = { id: "s1" } as never
let sessionCounter = 0
beforeEach(() => {
  session = { id: `session-${++sessionCounter}` } as never
  mockChatState.sessions = {}
})

function assistantLast(): Msg[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
  ]
}

describe("useFollowUpSuggestions", () => {
  beforeEach(() => {
    settingsState.settings = { composerAssistance: { suggestions: { followUps: true } } }
    mockChatState.messages = assistantLast()
    mockChatState.status = "idle"
    mockBuildClient.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockSuggest.mockReset().mockResolvedValue(["Tell me more", "Why?"])
  })

  it("fetches suggestions when idle with an assistant message last", async () => {
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toEqual(["Tell me more", "Why?"]))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })

  it("sends the generator the typed text, not the context envelope", async () => {
    // A suggestion keys off what was said. The envelope can be a page of web
    // results — a lot of tokens for a one-line suggestion, and material the
    // user never wrote.
    const { text } = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    mockChatState.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ]
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2))

    const [{ recentMessages }] = mockSuggest.mock.calls[0] as [
      { recentMessages: Array<{ role: string; text: string }> },
    ]
    expect(recentMessages[0]).toEqual({ role: "user", text: "typed words" })
    const sent = JSON.stringify(recentMessages)
    expect(sent).not.toContain("SECRET SNAPSHOT")
    expect(sent).not.toContain("cognia_context_")
  })

  it("returns nothing while streaming", async () => {
    mockChatState.status = "streaming"
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.suggestions).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("returns nothing when the last message is from the user", async () => {
    mockChatState.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.suggestions).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("is disabled when the setting is off", async () => {
    settingsState.settings = { composerAssistance: { suggestions: { followUps: false } } }
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.suggestions).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("returns nothing when no client can be built", async () => {
    mockBuildClient.mockReturnValue(null)
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.suggestions).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("dismiss() clears suggestions and prevents re-fetch for the same turn", async () => {
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2))
    act(() => result.current.dismiss())
    expect(result.current.suggestions).toEqual([])
    rerender()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })

  it("re-fetches when a new assistant turn arrives", async () => {
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2))
    mockChatState.messages = [
      ...assistantLast(),
      { id: "u2", role: "user", parts: [{ type: "text", text: "more" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "sure" }] },
    ]
    mockSuggest.mockResolvedValue(["Next?"])
    rerender()
    await waitFor(() => expect(result.current.suggestions).toEqual(["Next?"]))
    expect(mockSuggest).toHaveBeenCalledTimes(2)
  })
})

describe("useFollowUpSuggestions — agent fallback", () => {
  beforeEach(() => {
    mockChatState.messages = assistantLast()
    mockChatState.status = "idle"
    mockBuildClient.mockReset().mockReturnValue(null)
    mockHeadless.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockSuggest.mockReset().mockResolvedValue(["and then?"])
  })

  it("stays inert without the opt-in, even with no direct client", async () => {
    // The historical behaviour on a subscription. Turning it on by default
    // would spend an agent turn after every single reply.
    settingsState.settings = { composerAssistance: { suggestions: { followUps: true } } }
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockHeadless).not.toHaveBeenCalled()
    expect(result.current.suggestions).toEqual([])
  })

  it("falls back to one agent turn when opted in", async () => {
    settingsState.settings = {
      composerAssistance: { suggestions: { followUps: true, agentFallback: true } },
    }
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toEqual(["and then?"]))
    expect(mockHeadless).toHaveBeenCalled()
  })

  it("prefers the cheap direct client when one resolves", async () => {
    mockBuildClient.mockReturnValue({ complete: async () => "[]" })
    settingsState.settings = {
      composerAssistance: { suggestions: { followUps: true, agentFallback: true } },
    }
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toEqual(["and then?"]))
    // A user with a pasted key must never be charged an agent turn for this.
    expect(mockHeadless).not.toHaveBeenCalled()
  })
})

describe("useFollowUpSuggestions — ownership and lifecycle regressions", () => {
  beforeEach(() => {
    settingsState.settings = { composerAssistance: { suggestions: { followUps: true } } }
    mockChatState.messages = assistantLast()
    mockChatState.status = "idle"
    mockBuildClient.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockHeadless.mockReset().mockReturnValue(null)
    mockSuggest.mockReset().mockResolvedValue(["Continue B"])
  })

  it("reads the bound session while another session is active and streaming", async () => {
    const bound = { id: "bound-b" } as never
    mockChatState.status = "streaming"
    mockChatState.sessions["bound-b"] = {
      status: "idle",
      messages: [
        { id: "b-reply", role: "assistant", parts: [{ type: "text", text: "B visible branch" }] },
      ],
    }
    const { result } = renderHook(() => useFollowUpSuggestions(bound))
    await waitFor(() => expect(result.current.suggestions).toEqual(["Continue B"]))
    expect(mockSuggest.mock.calls[0][0].recentMessages).toEqual([
      { role: "assistant", text: "B visible branch" },
    ])
    expect(mockBuildClient.mock.calls[0][0].session).toEqual(bound)
  })

  it("reuses a settled result after remount without billing again", async () => {
    const first = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(first.result.current.suggestions).toHaveLength(1))
    first.unmount()
    const next = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(next.result.current.suggestions).toHaveLength(1))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })

  it("deduplicates two panes and retains dismissal across remount", async () => {
    const first = renderHook(() => useFollowUpSuggestions(session))
    const second = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(first.result.current.suggestions).toHaveLength(1))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
    act(() => first.result.current.dismiss())
    expect(second.result.current.suggestions).toEqual([])
    first.unmount()
    second.unmount()
    const next = renderHook(() => useFollowUpSuggestions(session))
    expect(next.result.current.suggestions).toEqual([])
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })

  it("shares a pending request across an immediate remount", async () => {
    let resolve!: (value: string[]) => void
    mockSuggest.mockImplementation(
      () =>
        new Promise<string[]>((done) => {
          resolve = done
        })
    )
    const first = renderHook(() => useFollowUpSuggestions(session))
    first.unmount()
    const next = renderHook(() => useFollowUpSuggestions(session))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
    await act(async () => resolve(["Shared result"]))
    expect(next.result.current.suggestions).toEqual(["Shared result"])
  })

  it("aborts when the last consumer leaves and ignores a late result", async () => {
    let resolve!: (value: string[]) => void
    let signal!: AbortSignal
    mockSuggest.mockImplementation((_context, dependencies) => {
      signal = dependencies.signal
      return new Promise<string[]>((done) => {
        resolve = done
      })
    })
    const first = renderHook(() => useFollowUpSuggestions(session))
    first.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(signal.aborted).toBe(true)
    mockSuggest.mockResolvedValue(["Fresh result"])
    const next = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(next.result.current.suggestions).toEqual(["Fresh result"]))
    await act(async () => resolve(["Late old result"]))
    expect(next.result.current.suggestions).toEqual(["Fresh result"])
  })

  it("keeps a dismissed pending result hidden even if its client ignores cancellation", async () => {
    let resolve!: (value: string[]) => void
    mockSuggest.mockImplementation(
      () =>
        new Promise<string[]>((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    act(() => result.current.dismiss())
    await act(async () => resolve(["Late result"]))
    expect(result.current.suggestions).toEqual([])
    expect(result.current.status).toBe("dismissed")
  })

  it("suppresses work for an occupied composer and reuses its result when cleared", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useFollowUpSuggestions(session, { enabled }),
      { initialProps: { enabled: false } }
    )
    expect(mockSuggest).not.toHaveBeenCalled()
    expect(result.current.status).toBe("ineligible")
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    rerender({ enabled: false })
    expect(result.current.suggestions).toEqual([])
    rerender({ enabled: true })
    expect(result.current.suggestions).toEqual(["Continue B"])
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })

  it("distinguishes unavailable backends, abstention, and retryable failures", async () => {
    mockBuildClient.mockReturnValue(null)
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    mockBuildClient.mockReturnValue({ complete: async () => "[]" })
    mockSuggest.mockRejectedValueOnce(new Error("offline"))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe("error"))
    rerender()
    expect(mockSuggest).toHaveBeenCalledTimes(1)
    mockSuggest.mockResolvedValue([])
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe("no-prediction"))
    expect(mockSuggest).toHaveBeenCalledTimes(2)
  })

  it("invalidates the same turn when its configured model changes", async () => {
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    settingsState.settings = {
      composerAssistance: { model: { model: "different-model" }, suggestions: { followUps: true } },
    }
    mockSuggest.mockResolvedValue(["New model"])
    rerender()
    await waitFor(() => expect(result.current.suggestions).toEqual(["New model"]))
    expect(mockSuggest).toHaveBeenCalledTimes(2)
  })

  it("times out hung direct requests and exposes retry", async () => {
    jest.useFakeTimers()
    try {
      mockSuggest.mockImplementation(() => new Promise(() => {}))
      const { result } = renderHook(() => useFollowUpSuggestions(session))
      await act(async () => {
        jest.advanceTimersByTime(15_000)
      })
      expect(result.current.status).toBe("error")
      expect(result.current.loading).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it("allows Agent startup longer than a direct completion watchdog", async () => {
    jest.useFakeTimers()
    try {
      settingsState.settings = {
        composerAssistance: { suggestions: { followUps: true, agentFallback: true } },
      }
      mockBuildClient.mockReturnValue(null)
      mockHeadless.mockReturnValue({ complete: async () => "[]" })
      let resolve!: (value: string[]) => void
      mockSuggest.mockImplementation(
        () =>
          new Promise<string[]>((done) => {
            resolve = done
          })
      )
      const { result } = renderHook(() => useFollowUpSuggestions(session))
      await act(async () => {
        jest.advanceTimersByTime(6_001)
      })
      expect(result.current.status).toBe("loading")
      await act(async () => resolve(["Slow Agent result"]))
      expect(result.current.suggestions).toEqual(["Slow Agent result"])
    } finally {
      jest.useRealTimers()
    }
  })

  it("invalidates a same-id reply when its visible content changes", async () => {
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    mockChatState.messages = [
      { ...assistantLast()[1], parts: [{ type: "text", text: "Regenerated result" }] },
    ]
    mockSuggest.mockResolvedValue(["New branch"])
    rerender()
    await waitFor(() => expect(result.current.suggestions).toEqual(["New branch"]))
    expect(mockSuggest).toHaveBeenCalledTimes(2)
  })
})

describe("useFollowUpSuggestions — native prediction ownership", () => {
  let prediction: NativePrediction
  beforeEach(() => {
    settingsState.settings = {
      composerAssistance: { suggestions: { followUps: true, agentFallback: true } },
    }
    prediction = {
      turnId: "native-turn",
      requestedAt: Date.now(),
      userMessageId: "u1",
      text: null,
    }
    mockChatState.sessions[(session as { id: string }).id] = {
      messages: assistantLast(),
      status: "idle",
      promptPrediction: prediction,
    }
    mockBuildClient.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockHeadless.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockSuggest.mockReset().mockResolvedValue(["Synthetic duplicate"])
  })

  it("uses the native prediction without resolving or billing a synthetic backend", async () => {
    prediction.text = "验证中文结果"
    prediction.contextKey = nativeContextKey(assistantLast())
    const first = renderHook(() => useFollowUpSuggestions(session))
    await waitFor(() => expect(first.result.current.suggestions).toEqual(["验证中文结果"]))
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockHeadless).not.toHaveBeenCalled()
    expect(mockSuggest).not.toHaveBeenCalled()
    act(() => first.result.current.dismiss())
    first.unmount()
    const next = renderHook(() => useFollowUpSuggestions(session))
    expect(next.result.current.suggestions).toEqual([])
    expect(next.result.current.status).toBe("dismissed")
  })

  it("waits for a native event then consumes its text without a second request", async () => {
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    expect(result.current.status).toBe("loading")
    prediction.text = "Run the checks"
    prediction.contextKey = nativeContextKey(assistantLast())
    rerender()
    await waitFor(() => expect(result.current.suggestions).toEqual(["Run the checks"]))
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("stops waiting for native text when the selected branch changes", async () => {
    prediction.branchKey = JSON.stringify({ group: "old-branch" })
    mockChatState.sessions[(session as { id: string }).id].activeBranchByGroup = {
      group: "new-branch",
    }
    const { result } = renderHook(() => useFollowUpSuggestions(session))
    expect(result.current.status).toBe("no-prediction")
    expect(result.current.suggestions).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("never exposes the preceding native turn after a new turn is requested", async () => {
    prediction.text = "Prior turn"
    prediction.contextKey = nativeContextKey(assistantLast())
    const { result, rerender } = renderHook(() => useFollowUpSuggestions(session))
    expect(result.current.suggestions).toEqual(["Prior turn"])
    mockChatState.sessions[(session as { id: string }).id].promptPrediction = {
      ...prediction,
      turnId: "new-turn",
      text: null,
    }
    rerender()
    expect(result.current.suggestions).toEqual([])
    expect(result.current.status).toBe("loading")
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("abstains after the native deadline and never auto-falls back or retries a full turn", async () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useFollowUpSuggestions(session))
      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      expect(result.current.status).toBe("no-prediction")
      act(() => result.current.retry())
      expect(mockSuggest).not.toHaveBeenCalled()
      expect(mockHeadless).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(["different user", "different visible branch"])(
    "ignores native text from a %s",
    async (mismatch) => {
      prediction.text = "Old native result"
      prediction.contextKey = nativeContextKey(assistantLast())
      if (mismatch === "different user") prediction.userMessageId = "other-user"
      else prediction.contextKey = "other-branch"
      const { result } = renderHook(() => useFollowUpSuggestions(session))
      await waitFor(() => expect(result.current.status).toBe("no-prediction"))
      expect(result.current.suggestions).toEqual([])
      expect(mockSuggest).not.toHaveBeenCalled()
    }
  )
})
