/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { useComposerGhostText } from "./use-composer-ghost-text"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"
import { composeTurnText } from "@/lib/chat/prompt-preamble"

/**
 * Let timers + provider promises settle inside `act`, so a late state update
 * (the debounced model tier landing after the assertion window) does not trip
 * React's "update not wrapped in act" warning.
 */
const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })

const mockSettingsState: { settings: Record<string, unknown> } = {
  settings: { composerAssistance: { ghostText: { enabled: true, debounceMs: 200 } } },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockSettingsState), {
    getState: () => mockSettingsState,
  }),
}))

type TestMessage = { role: string; parts: unknown }
const mockChatState = {
  messages: [] as TestMessage[],
  sessions: {} as Record<string, { messages: TestMessage[] }>,
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => mockChatState },
  useSessionVisibleMessages: (id: string) =>
    mockChatState.sessions[id]?.messages ?? mockChatState.messages,
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockBuildClient(...args),
}))

const mockHeadlessClient = jest.fn()
const mockCanRunHeadless = jest.fn(() => true)
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({
  buildHeadlessTurnLlmClient: (...args: unknown[]) => mockHeadlessClient(...args),
  canRunHeadlessTurn: () => mockCanRunHeadless(),
}))

const mockPii = jest.fn((..._args: unknown[]) => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (t: string) => mockPii(t),
}))

const session = { id: "sess-1" } as never
const COMMANDS: InlineCommandInfo[] = [{ name: "compact", description: "Compact the transcript" }]

/** Render the hook with the model tier on and both context sources empty. */
function render(opts: { history?: string[]; commands?: InlineCommandInfo[] } = {}) {
  return renderHook(() =>
    useComposerGhostText({
      session,
      history: opts.history ?? [],
      commands: opts.commands ?? COMMANDS,
    })
  )
}

describe("useComposerGhostText — model tier", () => {
  beforeEach(() => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: true, debounceMs: 200 } },
    }
    mockChatState.messages = []
    mockPii.mockReturnValue(true)
    mockBuildClient.mockReset()
    mockBuildClient.mockReturnValue({ complete: async () => " world" })
  })

  it("resolves and exposes a ghost suffix after feeding", async () => {
    const { result } = render()
    expect(result.current.enabled).toBe(true)
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    expect(result.current.suggestion?.source).toBe("ai")
  })

  it("accept() returns the joined value and clears the ghost", async () => {
    const { result } = render()
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    let accepted: string | null = null
    act(() => {
      accepted = result.current.accept()
    })
    expect(accepted).toBe("hello world")
    expect(result.current.ghost).toBe("")
  })

  it("yields no ghost when the PII gate rejects the context", async () => {
    mockPii.mockReturnValue(false)
    const { result } = render()
    act(() => result.current.feed("hello there"))
    await settle(300)
    expect(result.current.ghost).toBe("")
  })

  it("yields no ghost when the client throws", async () => {
    mockBuildClient.mockReturnValue({
      complete: async () => {
        throw new Error("boom")
      },
    })
    const { result } = render()
    act(() => result.current.feed("hello"))
    await settle(300)
    expect(result.current.ghost).toBe("")
  })

  it("yields no ghost when no client can be built", async () => {
    mockBuildClient.mockReturnValue(null)
    const { result } = render()
    act(() => result.current.feed("hello"))
    await settle(300)
    expect(result.current.ghost).toBe("")
  })

  it("feeds recent conversation text into the prompt", async () => {
    mockChatState.messages = [
      { role: "user", parts: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", parts: [{ type: "text", text: "earlier answer" }] },
    ]
    let seenPrompt = ""
    mockBuildClient.mockReturnValue({
      complete: async (p: string) => {
        seenPrompt = p
        return " continuation"
      },
    })
    const { result } = render()
    act(() => result.current.feed("now then"))
    await waitFor(() => expect(result.current.ghost).toBe(" continuation"))
    expect(seenPrompt).toContain("earlier answer")
  })

  it("feeds the typed text of a recent turn, not its context envelope", async () => {
    // A continuation keys off what was said. A referenced snapshot or a page of
    // web results is a lot of tokens to pay per keystroke-debounce, and it is
    // not the user's writing to continue.
    const { text } = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    mockChatState.messages = [{ role: "user", parts: [{ type: "text", text }] }]
    let seenPrompt = ""
    mockBuildClient.mockReturnValue({
      complete: async (p: string) => {
        seenPrompt = p
        return " continuation"
      },
    })
    const { result } = render()
    act(() => result.current.feed("now then"))
    await waitFor(() => expect(result.current.ghost).toBe(" continuation"))
    expect(seenPrompt).toContain("typed words")
    expect(seenPrompt).not.toContain("SECRET SNAPSHOT")
    expect(seenPrompt).not.toContain("cognia_context_")
  })

  it("dismiss() clears any visible ghost", async () => {
    const { result } = render()
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    act(() => result.current.dismiss())
    expect(result.current.ghost).toBe("")
  })

  it("suppresses everything when the caller says so", async () => {
    const { result } = render({ history: ["hello world"] })
    act(() => result.current.feed("hello", { suppress: true }))
    await settle(300)
    expect(result.current.ghost).toBe("")
  })
})

describe("useComposerGhostText — local tier", () => {
  beforeEach(() => {
    // Model tier OFF: this is the configuration most users are actually in,
    // and it used to mean "no completion at all".
    mockSettingsState.settings = { composerAssistance: { ghostText: { enabled: false } } }
    mockChatState.messages = []
    mockPii.mockReturnValue(true)
    mockBuildClient.mockReset()
    mockBuildClient.mockReturnValue({ complete: async () => " world" })
  })

  it("still completes from history with the model tier off", async () => {
    const { result } = render({ history: ["hello from history"] })
    expect(result.current.enabled).toBe(true)
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" from history"))
    expect(result.current.suggestion?.source).toBe("history")
    // The whole point: no model was consulted.
    expect(mockBuildClient).not.toHaveBeenCalled()
  })

  it("completes a slash command name", async () => {
    const { result } = render()
    act(() => result.current.feed("/comp"))
    await waitFor(() => expect(result.current.ghost).toBe("act"))
    expect(result.current.suggestion?.source).toBe("command")
  })

  it("cycles through ranked candidates and accepts the chosen one", async () => {
    const { result } = render({ history: ["hello beta", "hello alpha"] })
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.candidates.length).toBe(2))
    expect(result.current.ghost).toBe(" beta")
    act(() => result.current.cycleNext())
    expect(result.current.ghost).toBe(" alpha")
    expect(result.current.index).toBe(1)
    act(() => result.current.cyclePrev())
    expect(result.current.ghost).toBe(" beta")
    let accepted: string | null = null
    act(() => {
      accepted = result.current.accept()
    })
    expect(accepted).toBe("hello beta")
  })

  it("reports disabled and suggests nothing when BOTH tiers are off", async () => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: false, local: false } },
    }
    const { result } = render({ history: ["hello from history"] })
    expect(result.current.enabled).toBe(false)
    act(() => result.current.feed("hello"))
    await settle(300)
    expect(result.current.ghost).toBe("")
    expect(result.current.accept()).toBeNull()
    expect(mockBuildClient).not.toHaveBeenCalled()
  })

  it("merges both tiers, letting the model outrank history", async () => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: true, local: true, debounceMs: 200 } },
    }
    const { result } = render({ history: ["hello from history"] })
    act(() => result.current.feed("hello"))
    // Local first...
    await waitFor(() => expect(result.current.ghost).toBe(" from history"))
    // ...then the model upgrades it in place.
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    expect(result.current.candidates.length).toBe(2)
  })
})

describe("useComposerGhostText — agent tier", () => {
  beforeEach(() => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: true, local: false, debounceMs: 200 } },
    }
    mockChatState.messages = []
    mockBuildClient.mockReset()
    mockHeadlessClient.mockReset()
    mockCanRunHeadless.mockReset()
    mockCanRunHeadless.mockReturnValue(true)
    mockPii.mockReset()
    mockPii.mockReturnValue(true)
  })

  it("advertises itself when a turn can be carried", async () => {
    mockBuildClient.mockReturnValue(null)
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "the staging build") })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await waitFor(() => expect(result.current.manualAvailable).toBe(true))
  })

  it("stays away when no transport can carry a turn", async () => {
    // A pure web tab with no paired companion: there is nothing to fall back TO,
    // so the key must not be advertised.
    mockCanRunHeadless.mockReturnValue(false)
    mockBuildClient.mockReturnValue(null)
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await settle(300)
    expect(result.current.manualAvailable).toBe(false)
  })

  it("does not run a turn on a keystroke", async () => {
    mockBuildClient.mockReturnValue(null)
    const complete = jest.fn(async () => "the staging build")
    mockHeadlessClient.mockReturnValue({ complete })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await settle(1_000)
    expect(complete).not.toHaveBeenCalled()
    expect(result.current.ghost).toBe("")
  })

  it("rescues the model tier on a subscription — no direct client, still completes", async () => {
    // The whole point: `buildUtilityLlmClient` returns null on a subscription,
    // which used to mean the feature the user switched on did nothing at all.
    mockBuildClient.mockReturnValue(null)
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "the staging build") })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await waitFor(() => expect(result.current.manualAvailable).toBe(true))

    await act(async () => {
      result.current.requestManual()
    })
    await waitFor(() => expect(result.current.ghost).toBe("the staging build"))
    expect(result.current.suggestion?.source).toBe("agent")
  })

  it("outranks the direct model tier when both answer", async () => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: true, debounceMs: 50 } },
    }
    mockBuildClient.mockReturnValue({ complete: jest.fn(async () => "it") })
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "the staging build") })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await waitFor(() => expect(result.current.ghost).toBe("it"))

    await act(async () => {
      result.current.requestManual()
    })
    // The answer the user deliberately asked for beats the one a timer produced.
    await waitFor(() => expect(result.current.ghost).toBe("the staging build"))
  })

  it("accepts the agent continuation like any other suggestion", async () => {
    mockBuildClient.mockReturnValue(null)
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "the staging build") })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await waitFor(() => expect(result.current.manualAvailable).toBe(true))
    await act(async () => {
      result.current.requestManual()
    })
    await waitFor(() => expect(result.current.ghost).toBe("the staging build"))

    let accepted: string | null = null
    act(() => {
      accepted = result.current.accept()
    })
    expect(accepted).toBe("deploy the staging build")
  })

  it("stays silent when the PII gate rejects the draft", async () => {
    mockBuildClient.mockReturnValue(null)
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "the staging build") })
    mockPii.mockReturnValue(false)
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await waitFor(() => expect(result.current.manualAvailable).toBe(true))
    await act(async () => {
      result.current.requestManual()
    })
    await settle(200)
    expect(result.current.ghost).toBe("")
  })

  it("is not offered at all with the model tier switched off", async () => {
    mockSettingsState.settings = { composerAssistance: { ghostText: { enabled: false } } }
    mockHeadlessClient.mockReturnValue({ complete: jest.fn(async () => "x") })
    const { result } = render()
    act(() => result.current.feed("deploy "))
    await settle(100)
    expect(result.current.manualAvailable).toBe(false)
  })
})

describe("useComposerGhostText — session isolation regression", () => {
  beforeEach(() => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: true, local: false, debounceMs: 200 } },
    }
    mockChatState.sessions = {}
    mockChatState.messages = [
      { role: "assistant", parts: [{ type: "text", text: "Active A context" }] },
    ]
    mockPii.mockReturnValue(true)
    mockCanRunHeadless.mockReturnValue(false)
    mockBuildClient.mockReset()
  })

  it("does not rerender indefinitely when a composer re-feeds the same empty input", () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      if (renders > 10) throw new Error("Repeated empty-feed render loop")
      const ghost = useComposerGhostText({ session, history: [], commands: [] })
      // Composer trigger state can be recomputed while editing. Re-feeding an
      // unchanged empty input must preserve the engine's cached empty view.
      useEffect(() => ghost.feed(""))
      return ghost
    })
    expect(result.current.ghost).toBe("")
    expect(renders).toBeLessThanOrEqual(4)
  })

  it("uses only the owning session's visible transcript", async () => {
    mockChatState.sessions["sess-1"] = {
      messages: [{ role: "assistant", parts: [{ type: "text", text: "Visible B context" }] }],
    }
    const complete = jest.fn(async (_prompt: string) => " continuation")
    mockBuildClient.mockReturnValue({ complete })
    const { result } = render()
    act(() => result.current.feed("Continue"))
    await waitFor(() => expect(result.current.ghost).toBe(" continuation"))
    expect(complete.mock.calls[0][0]).toContain("Visible B context")
    expect(complete.mock.calls[0][0]).not.toContain("Active A context")
  })

  it("does not restore or accept another empty session's draft when switching panes", async () => {
    mockSettingsState.settings = {
      composerAssistance: { ghostText: { enabled: false, local: true } },
    }
    mockChatState.sessions["empty-a"] = { messages: [] }
    mockChatState.sessions["empty-b"] = { messages: [] }
    const { result, rerender } = renderHook(
      ({ bound, history }) => useComposerGhostText({ session: bound, history, commands: [] }),
      { initialProps: { bound: { id: "empty-a" } as never, history: ["hello A"] } }
    )
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" A"))
    rerender({ bound: { id: "empty-b" } as never, history: ["hello B"] })
    expect(result.current.ghost).toBe("")
    expect(result.current.accept()).toBeNull()
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" B"))
    expect(mockBuildClient).not.toHaveBeenCalled()
  })

  it("requeries the existing draft after the configured model changes", async () => {
    const complete = jest.fn(async (_prompt: string) => " old")
    mockBuildClient.mockReturnValue({ complete })
    const { result, rerender } = render()
    act(() => result.current.feed("Continue"))
    await waitFor(() => expect(result.current.ghost).toBe(" old"))
    complete.mockResolvedValue(" new model")
    mockSettingsState.settings = {
      composerAssistance: {
        model: { model: "replacement-model" },
        ghostText: { enabled: true, local: false, debounceMs: 200 },
      },
    }
    rerender()
    await waitFor(() => expect(result.current.ghost).toBe(" new model"))
    expect(complete).toHaveBeenCalledTimes(2)
    expect(mockBuildClient.mock.calls.at(-1)?.[0].override).toEqual({ model: "replacement-model" })
  })

  it("preserves IME/popup suppression when rebuilding for a new branch", async () => {
    mockChatState.sessions["sess-1"] = {
      messages: [{ role: "assistant", parts: [{ type: "text", text: "Old branch" }] }],
    }
    const complete = jest.fn(async () => " continuation")
    mockBuildClient.mockReturnValue({ complete })
    const { result, rerender } = render()
    act(() => result.current.feed("Continue", { suppress: true }))
    mockChatState.sessions["sess-1"].messages = [
      { role: "assistant", parts: [{ type: "text", text: "New branch" }] },
    ]
    rerender()
    await settle(300)
    expect(result.current.ghost).toBe("")
    expect(complete).not.toHaveBeenCalled()
  })

  it("drops cached draft predictions when the visible branch changes", async () => {
    mockChatState.sessions["sess-1"] = {
      messages: [{ role: "assistant", parts: [{ type: "text", text: "Old branch" }] }],
    }
    const complete = jest.fn(async (_prompt: string) => " old")
    mockBuildClient.mockReturnValue({ complete })
    const { result, rerender } = render()
    act(() => result.current.feed("Continue"))
    await waitFor(() => expect(result.current.ghost).toBe(" old"))
    mockChatState.sessions["sess-1"].messages = [
      { role: "assistant", parts: [{ type: "text", text: "New branch" }] },
    ]
    complete.mockResolvedValue(" new")
    rerender()
    await waitFor(() => expect(result.current.ghost).toBe(" new"))
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][0]).toContain("New branch")
  })
})
