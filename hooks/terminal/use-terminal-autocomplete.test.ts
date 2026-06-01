import { act, renderHook, waitFor } from "@testing-library/react"
import { useTerminalAutocomplete } from "./use-terminal-autocomplete"
import { __resetCompletionRegistryForTesting } from "@/lib/terminal/completion/registry"
import { __resetBuiltinCompletionProvidersForTesting } from "@/lib/terminal/completion/builtins"

const mockSettingsState: {
  settings: {
    terminal: { autocomplete: { enabled: boolean; source: string; debounceMs: number } }
  }
} = {
  settings: { terminal: { autocomplete: { enabled: true, source: "history", debounceMs: 50 } } },
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockSettingsState), {
    getState: () => mockSettingsState,
  }),
}))

const mockTerminalState = {
  sessions: {
    s1: {
      id: "s1",
      shell: "/bin/bash",
      cwd: "/repo",
      lastCommands: [{ cmd: "git status", exitCode: 0, endedAt: 1 }],
    },
  } as Record<string, unknown>,
}

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => mockTerminalState },
}))

const mockBuildClient = jest.fn(() => null as unknown)
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockBuildClient(...args),
}))

function feedAll(feed: (c: string) => void, text: string) {
  for (const ch of text) feed(ch)
}

describe("useTerminalAutocomplete", () => {
  beforeEach(() => {
    __resetCompletionRegistryForTesting()
    __resetBuiltinCompletionProvidersForTesting()
    mockSettingsState.settings.terminal.autocomplete.enabled = true
    mockSettingsState.settings.terminal.autocomplete.source = "history"
    mockBuildClient.mockReset().mockReturnValue(null)
  })

  it("shows a history-based ghost suffix after typing", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    expect(result.current.enabled).toBe(true)
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    expect(result.current.suggestion?.text).toBe("git status")
  })

  it("accept() returns the suffix and clears the ghost", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    let suffix: string | null = null
    act(() => {
      suffix = result.current.accept()
    })
    expect(suffix).toBe("status")
    await waitFor(() => expect(result.current.ghost).toBe(""))
  })

  it("dismiss() hides the suggestion", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    act(() => result.current.dismiss())
    expect(result.current.ghost).toBe("")
  })

  it("uses the LLM client for AI-sourced suggestions", async () => {
    mockSettingsState.settings.terminal.autocomplete.source = "ai"
    mockBuildClient.mockReturnValue({ complete: async () => "git status" })
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "terminal-autocomplete" })
    )
    expect(result.current.suggestion?.source).toBe("ai")
  })

  it("yields no suggestion when the session row is missing", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("does-not-exist"))
    act(() => feedAll(result.current.feed, "git "))
    await new Promise((r) => setTimeout(r, 80))
    expect(result.current.ghost).toBe("")
  })

  it("tolerates a row with no cwd or history", async () => {
    mockTerminalState.sessions["s2"] = { id: "s2", shell: "/bin/zsh" } // no cwd, no lastCommands
    const { result } = renderHook(() => useTerminalAutocomplete("s2"))
    act(() => feedAll(result.current.feed, "ls "))
    // No history + AI off → no ghost, but must not throw.
    await new Promise((r) => setTimeout(r, 80))
    expect(result.current.ghost).toBe("")
    delete mockTerminalState.sessions["s2"]
  })

  it("is a no-op when disabled", async () => {
    mockSettingsState.settings.terminal.autocomplete.enabled = false
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    expect(result.current.enabled).toBe(false)
    act(() => feedAll(result.current.feed, "git "))
    // Give the debounce window a chance — nothing should appear.
    await new Promise((r) => setTimeout(r, 80))
    expect(result.current.ghost).toBe("")
    expect(result.current.accept()).toBeNull()
  })
})
