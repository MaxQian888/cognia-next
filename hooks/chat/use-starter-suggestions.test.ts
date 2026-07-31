import { renderHook, waitFor } from "@testing-library/react"
import { useStarterSuggestions } from "./use-starter-suggestions"

const settingsState: { settings: Record<string, unknown> } = {
  settings: { composerAssistance: { suggestions: { starters: true } } },
}
const chatState = { messages: [] as unknown[] }

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: Object.assign((sel: (s: unknown) => unknown) => sel(chatState), {
    getState: () => chatState,
  }),
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))

const mockSuggest = jest.fn()
jest.mock("@/lib/chat/completion/suggestions", () => ({
  suggestStarters: (...a: unknown[]) => mockSuggest(...a),
}))

const session = { id: "s1" } as never

describe("useStarterSuggestions", () => {
  beforeEach(() => {
    settingsState.settings = { composerAssistance: { suggestions: { starters: true } } }
    chatState.messages = []
    mockBuildClient.mockReset().mockReturnValue({ complete: async () => "[]" })
    mockSuggest.mockReset().mockResolvedValue(["Explore the repo", "Write a test"])
  })

  it("fetches starters when the conversation is empty", async () => {
    const { result } = renderHook(() => useStarterSuggestions(session))
    await waitFor(() => expect(result.current).toEqual(["Explore the repo", "Write a test"]))
  })

  it("passes the persona through", async () => {
    renderHook(() => useStarterSuggestions(session, { name: "Ada", description: "tutor" }))
    await waitFor(() => expect(mockSuggest).toHaveBeenCalled())
    expect(mockSuggest).toHaveBeenCalledWith(
      { characterName: "Ada", characterDescription: "tutor" },
      expect.anything()
    )
  })

  it("returns [] when the conversation has messages", async () => {
    chatState.messages = [{ id: "m1" }]
    const { result } = renderHook(() => useStarterSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("is disabled when the setting is off", async () => {
    settingsState.settings = { composerAssistance: { suggestions: { starters: false } } }
    const { result } = renderHook(() => useStarterSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current).toEqual([])
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("returns [] when no client can be built", async () => {
    mockBuildClient.mockReturnValue(null)
    const { result } = renderHook(() => useStarterSuggestions(session))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current).toEqual([])
  })

  it("fetches only once per session", async () => {
    const { rerender } = renderHook(() => useStarterSuggestions(session))
    await waitFor(() => expect(mockSuggest).toHaveBeenCalledTimes(1))
    rerender()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockSuggest).toHaveBeenCalledTimes(1)
  })
})
