import { act, renderHook, waitFor } from "@testing-library/react"
import { useComposerGhostText } from "./use-composer-ghost-text"

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
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (t: string) => mockPii(t),
}))

const session = { id: "sess-1" } as never

describe("useComposerGhostText", () => {
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
    const { result } = renderHook(() => useComposerGhostText(session))
    expect(result.current.enabled).toBe(true)
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
  })

  it("accept() returns the joined value and clears the ghost", async () => {
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    let accepted: string | null = null
    act(() => {
      accepted = result.current.accept()
    })
    expect(accepted).toBe("hello world")
    expect(result.current.ghost).toBe("")
  })

  it("does nothing when the feature is disabled", async () => {
    mockSettingsState.settings = { composerAssistance: { ghostText: { enabled: false } } }
    const { result } = renderHook(() => useComposerGhostText(session))
    expect(result.current.enabled).toBe(false)
    act(() => result.current.feed("hello"))
    await new Promise((r) => setTimeout(r, 250))
    expect(result.current.ghost).toBe("")
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(result.current.accept()).toBeNull()
  })

  it("yields no ghost when the PII gate rejects the context", async () => {
    mockPii.mockReturnValue(false)
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("hello with a secret"))
    await new Promise((r) => setTimeout(r, 250))
    expect(result.current.ghost).toBe("")
  })

  it("yields no ghost when the client throws", async () => {
    mockBuildClient.mockReturnValue({
      complete: async () => {
        throw new Error("boom")
      },
    })
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("hello"))
    await new Promise((r) => setTimeout(r, 250))
    expect(result.current.ghost).toBe("")
  })

  it("yields no ghost when no client can be built", async () => {
    mockBuildClient.mockReturnValue(null)
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("hello"))
    await new Promise((r) => setTimeout(r, 250))
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
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("now then"))
    await waitFor(() => expect(result.current.ghost).toBe(" continuation"))
    expect(seenPrompt).toContain("earlier answer")
  })

  it("dismiss() clears any visible ghost", async () => {
    const { result } = renderHook(() => useComposerGhostText(session))
    act(() => result.current.feed("hello"))
    await waitFor(() => expect(result.current.ghost).toBe(" world"))
    act(() => result.current.dismiss())
    expect(result.current.ghost).toBe("")
  })
})
