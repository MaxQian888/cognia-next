/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useComposerGhostText } from "./use-composer-ghost-text"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"

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

const mockChatState = { messages: [] as { role: string; parts: unknown }[] }
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => mockChatState },
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockBuildClient(...args),
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
