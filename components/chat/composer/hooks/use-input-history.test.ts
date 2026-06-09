import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useInputHistory } from "./use-input-history"
import { getDb } from "@/lib/db/schema"
import { recordInput } from "@/lib/db/chat-input-history"

beforeEach(async () => {
  await getDb().chatInputHistory.clear()
})

async function seed(sessionId: string, texts: string[]) {
  for (const t of texts) await recordInput(sessionId, t)
}

describe("useInputHistory", () => {
  it("walks back through history on ↑ from the start, newest first", async () => {
    await seed("s1", ["one", "two", "three"]) // newest = three
    const { result } = renderHook(() => useInputHistory("s1"))
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0))

    const opts = { value: "", caretAtStart: true }
    let v: string | null = null
    act(() => {
      v = result.current.recall("up", opts)
    })
    expect(v).toBe("three")
    act(() => {
      v = result.current.recall("up", opts)
    })
    expect(v).toBe("two")
    act(() => {
      v = result.current.recall("up", opts)
    })
    expect(v).toBe("one")
    // clamps at the oldest entry
    act(() => {
      v = result.current.recall("up", opts)
    })
    expect(v).toBe("one")
  })

  it("does not recall on ↑ when the caret is not at the start", async () => {
    await seed("s1", ["one"])
    const { result } = renderHook(() => useInputHistory("s1"))
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0))
    let v: string | null = "x"
    act(() => {
      v = result.current.recall("up", { value: "typing", caretAtStart: false })
    })
    expect(v).toBeNull()
  })

  it("↓ walks forward and restores the stashed draft past the newest entry", async () => {
    await seed("s1", ["a", "b"]) // newest = b
    const { result } = renderHook(() => useInputHistory("s1"))
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0))

    let v: string | null = null
    act(() => {
      v = result.current.recall("up", { value: "draft-in-progress", caretAtStart: true })
    })
    expect(v).toBe("b")
    act(() => {
      v = result.current.recall("up", { value: "b", caretAtStart: false })
    })
    expect(v).toBe("a")
    act(() => {
      v = result.current.recall("down", { value: "a", caretAtStart: false })
    })
    expect(v).toBe("b")
    act(() => {
      v = result.current.recall("down", { value: "b", caretAtStart: false })
    })
    expect(v).toBe("draft-in-progress") // stash restored
  })

  it("↓ is a no-op when not navigating", async () => {
    const { result } = renderHook(() => useInputHistory("s1"))
    let v: string | null = "x"
    act(() => {
      v = result.current.recall("down", { value: "", caretAtStart: false })
    })
    expect(v).toBeNull()
  })

  it("noteEdit exits recall mode so ↑ starts from newest again", async () => {
    await seed("s1", ["a", "b"])
    const { result } = renderHook(() => useInputHistory("s1"))
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0))
    act(() => {
      result.current.recall("up", { value: "", caretAtStart: true })
    })
    act(() => result.current.noteEdit())
    let v: string | null = null
    act(() => {
      v = result.current.recall("up", { value: "edited", caretAtStart: true })
    })
    expect(v).toBe("b") // newest, not continuing from "a"
  })

  it("record persists and optimistically prepends", async () => {
    const { result } = renderHook(() => useInputHistory("s1"))
    act(() => result.current.record("hello"))
    let v: string | null = null
    act(() => {
      v = result.current.recall("up", { value: "", caretAtStart: true })
    })
    expect(v).toBe("hello")
    await waitFor(async () => {
      const { listInputHistory } = await import("@/lib/db/chat-input-history")
      expect(await listInputHistory("s1")).toContain("hello")
    })
  })
})
