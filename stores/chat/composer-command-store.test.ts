import { act, renderHook } from "@testing-library/react"
import { useComposerCommandStore, isCommandPinned, RECENT_LIMIT } from "./composer-command-store"

describe("useComposerCommandStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useComposerCommandStore.setState({ recentCommands: [], pinnedCommands: [] })
  })

  describe("noteCommandUsed", () => {
    it("prepends the most recent command", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.noteCommandUsed("model"))
      act(() => result.current.noteCommandUsed("review"))
      expect(result.current.recentCommands).toEqual(["review", "model"])
    })

    it("dedupes — re-using a command moves it to the front", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.noteCommandUsed("a"))
      act(() => result.current.noteCommandUsed("b"))
      act(() => result.current.noteCommandUsed("a"))
      expect(result.current.recentCommands).toEqual(["a", "b"])
    })

    it("caps the list at RECENT_LIMIT", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => {
        for (let i = 0; i < RECENT_LIMIT + 3; i++) result.current.noteCommandUsed(`cmd${i}`)
      })
      expect(result.current.recentCommands).toHaveLength(RECENT_LIMIT)
      // Newest first; oldest fell off.
      expect(result.current.recentCommands[0]).toBe(`cmd${RECENT_LIMIT + 2}`)
      expect(result.current.recentCommands).not.toContain("cmd0")
    })

    it("ignores an empty name", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.noteCommandUsed(""))
      expect(result.current.recentCommands).toEqual([])
    })
  })

  describe("togglePin", () => {
    it("pins and unpins a command", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.togglePin("git/commit"))
      expect(result.current.pinnedCommands).toEqual(["git/commit"])
      act(() => result.current.togglePin("git/commit"))
      expect(result.current.pinnedCommands).toEqual([])
    })

    it("appends new pins in pin order", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.togglePin("a"))
      act(() => result.current.togglePin("b"))
      expect(result.current.pinnedCommands).toEqual(["a", "b"])
    })

    it("ignores an empty name", () => {
      const { result } = renderHook(() => useComposerCommandStore())
      act(() => result.current.togglePin(""))
      expect(result.current.pinnedCommands).toEqual([])
    })
  })

  describe("isCommandPinned", () => {
    it("reflects the live pinned set", () => {
      expect(isCommandPinned("x")).toBe(false)
      act(() => useComposerCommandStore.getState().togglePin("x"))
      expect(isCommandPinned("x")).toBe(true)
    })
  })

  it("persists recent + pinned to localStorage", () => {
    act(() => {
      useComposerCommandStore.getState().noteCommandUsed("model")
      useComposerCommandStore.getState().togglePin("review")
    })
    const raw = window.localStorage.getItem("cognia-composer-commands")
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.recentCommands).toEqual(["model"])
    expect(parsed.state.pinnedCommands).toEqual(["review"])
  })
})
