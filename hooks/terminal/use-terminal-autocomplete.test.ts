import { act, renderHook, waitFor } from "@testing-library/react"
import { useTerminalAutocomplete } from "./use-terminal-autocomplete"
import { __resetCompletionRegistryForTesting } from "@/lib/terminal/completion/registry"
import { __resetBuiltinCompletionProvidersForTesting } from "@/lib/terminal/completion/builtins"

const mockSettingsState: {
  settings: {
    terminal: {
      autocomplete: {
        enabled: boolean
        source: string
        debounceMs: number
        path: boolean
        exe: boolean
        spec: boolean
        popup: boolean
      }
    }
  }
} = {
  settings: {
    terminal: {
      autocomplete: {
        enabled: true,
        source: "history",
        debounceMs: 50,
        // The desktop/spec providers are exercised in their own suites —
        // keep these hook tests pinned to the history provider.
        path: false,
        exe: false,
        spec: false,
        popup: true,
      },
    },
  },
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

const mockBuildClient = jest.fn((..._args: unknown[]) => null as unknown)
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockBuildClient(...args),
}))

function feedAll(feed: (c: string) => void, text: string) {
  for (const ch of text) feed(ch)
}

async function waitForAutocomplete(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

describe("useTerminalAutocomplete", () => {
  beforeEach(() => {
    __resetCompletionRegistryForTesting()
    __resetBuiltinCompletionProvidersForTesting()
    mockSettingsState.settings.terminal.autocomplete.enabled = true
    mockSettingsState.settings.terminal.autocomplete.source = "history"
    mockSettingsState.settings.terminal.autocomplete.path = false
    mockSettingsState.settings.terminal.autocomplete.exe = false
    mockSettingsState.settings.terminal.autocomplete.spec = false
    mockSettingsState.settings.terminal.autocomplete.popup = true
    mockBuildClient.mockReset().mockReturnValue(null)
  })

  it("shows a history-based ghost suffix after typing", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    expect(result.current.enabled).toBe(true)
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    expect(result.current.ghostSuggestion?.text).toBe("git status")
  })

  it("accept() returns the edit and clears the ghost", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    let edit: { backspaces: number; write: string } | null = null
    act(() => {
      edit = result.current.accept()
    })
    expect(edit).toEqual({ backspaces: 0, write: "status" })
    await waitFor(() => expect(result.current.ghost).toBe(""))
  })

  it("openList()/moveSelection()/acceptSelected() drive the popup", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    act(() => result.current.openList())
    await waitFor(() => expect(result.current.listOpen).toBe(true))
    expect(result.current.candidates.length).toBeGreaterThan(0)
    expect(result.current.selectedIndex).toBe(0)
    let edit: { backspaces: number; write: string } | null = null
    act(() => {
      edit = result.current.acceptSelected()
    })
    expect(edit).toEqual({ backspaces: 0, write: "status" })
    await waitFor(() => expect(result.current.listOpen).toBe(false))
  })

  it("closeList() keeps the ghost suggestion", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    act(() => result.current.openList())
    await waitFor(() => expect(result.current.listOpen).toBe(true))
    act(() => result.current.closeList())
    expect(result.current.listOpen).toBe(false)
    expect(result.current.ghost).toBe("status")
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
    expect(result.current.ghostSuggestion?.source).toBe("ai")
  })

  it("yields no suggestion when the session row is missing", async () => {
    const { result } = renderHook(() => useTerminalAutocomplete("does-not-exist"))
    act(() => feedAll(result.current.feed, "git "))
    await waitForAutocomplete(80)
    expect(result.current.ghost).toBe("")
  })

  it("tolerates a row with no cwd or history", async () => {
    mockTerminalState.sessions["s2"] = { id: "s2", shell: "/bin/zsh" } // no cwd, no lastCommands
    const { result } = renderHook(() => useTerminalAutocomplete("s2"))
    act(() => feedAll(result.current.feed, "ls "))
    // No history + AI off → no ghost, but must not throw.
    await waitForAutocomplete(80)
    expect(result.current.ghost).toBe("")
    delete mockTerminalState.sessions["s2"]
  })

  it("openList() is a no-op when the popup setting is off", async () => {
    mockSettingsState.settings.terminal.autocomplete.popup = false
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    expect(result.current.popupEnabled).toBe(false)
    act(() => feedAll(result.current.feed, "git "))
    await waitFor(() => expect(result.current.ghost).toBe("status"))
    act(() => result.current.openList())
    await waitForAutocomplete(80)
    expect(result.current.listOpen).toBe(false)
  })

  it("filters deny-verdict suggestions out entirely", async () => {
    mockTerminalState.sessions["s3"] = {
      id: "s3",
      shell: "/bin/bash",
      cwd: "/repo",
      lastCommands: [{ cmd: "rm -rf / --no-preserve-root", exitCode: 1, endedAt: 1 }],
    }
    const { result } = renderHook(() => useTerminalAutocomplete("s3"))
    act(() => feedAll(result.current.feed, "rm"))
    await waitForAutocomplete(120)
    expect(result.current.ghost).toBe("")
    expect(result.current.candidates).toHaveLength(0)
    delete mockTerminalState.sessions["s3"]
  })

  it("is a no-op when disabled", async () => {
    mockSettingsState.settings.terminal.autocomplete.enabled = false
    const { result } = renderHook(() => useTerminalAutocomplete("s1"))
    expect(result.current.enabled).toBe(false)
    act(() => feedAll(result.current.feed, "git "))
    // Give the debounce window a chance — nothing should appear.
    await waitForAutocomplete(80)
    expect(result.current.ghost).toBe("")
    expect(result.current.accept()).toBeNull()
  })
})
