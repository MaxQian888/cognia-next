import { act, renderHook, waitFor } from "@testing-library/react"
import { useFollowUpSuggestions } from "./use-follow-up-suggestions"

type Msg = { id: string; role: string; parts: unknown }
const mockChatState: { messages: Msg[]; status: string } = { messages: [], status: "idle" }
const settingsState: { settings: Record<string, unknown> } = {
  settings: { composerAssistance: { suggestions: { followUps: true } } },
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockChatState), {
    getState: () => mockChatState,
  }),
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))

const mockSuggest = jest.fn()
jest.mock("@/lib/chat/completion/suggestions", () => ({
  suggestFollowUps: (...a: unknown[]) => mockSuggest(...a),
}))

const session = { id: "s1" } as never

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
