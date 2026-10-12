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

  it("does not double-prepend a consecutive duplicate record", async () => {
    const { result } = renderHook(() => useInputHistory("s1"))
    act(() => result.current.record("dup"))
    act(() => result.current.record("dup"))
    expect(result.current.size).toBe(1)
    // `record` persists without being awaited. Let the write land here, or it
    // reaches the table after the next test's `beforeEach` cleared it — and
    // that test, which recalls across every conversation, would find it.
    await waitFor(async () =>
      expect(await getDb().chatInputHistory.where("sessionId").equals("s1").count()).toBe(1)
    )
  })

  it("ignores empty records and stays empty for a null session", async () => {
    const { result } = renderHook(() => useInputHistory(null))
    await waitFor(() => expect(result.current.size).toBe(0))
    act(() => result.current.record("   "))
    expect(result.current.size).toBe(0)
    expect(result.current.crossSessionEntries).toEqual([])
    expect(await getDb().chatInputHistory.count()).toBe(0)
    let v: string | null = "x"
    act(() => {
      v = result.current.recall("up", { value: "", caretAtStart: true })
    })
    expect(v).toBeNull()
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

  it("walks on into other conversations' lines once this one's run out", async () => {
    await seed("s1", ["mine-old", "mine-new"])
    await seed("s2", ["theirs-old", "mine-new", "theirs-new"])
    const { result } = renderHook(() => useInputHistory("s1"))
    await waitFor(() => expect(result.current.crossSessionEntries.length).toBeGreaterThan(0))
    // A line this conversation already has is not offered twice.
    expect(result.current.crossSessionEntries).toEqual(["theirs-new", "theirs-old"])

    const seen: Array<string | null> = []
    act(() => {
      seen.push(result.current.recall("up", { value: "", caretAtStart: true }))
    })
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        seen.push(result.current.recall("up", { value: "", caretAtStart: true }))
      })
    }
    expect(seen).toEqual(["mine-new", "mine-old", "theirs-new", "theirs-old", "theirs-old"])
  })

  it("keeps a first message sent before its conversation existed", async () => {
    const { result, rerender } = renderHook(({ id }) => useInputHistory(id), {
      initialProps: { id: null as string | null },
    })
    act(() => result.current.record("kick off the migration"))
    await waitFor(async () => {
      const { listInputHistory, HOME_COMPOSER_HISTORY_KEY } =
        await import("@/lib/db/chat-input-history")
      expect(await listInputHistory(HOME_COMPOSER_HISTORY_KEY)).toEqual(["kick off the migration"])
    })
    // The send just created the conversation: its composer can still recall it.
    rerender({ id: "s-new" })
    await waitFor(() =>
      expect(result.current.crossSessionEntries).toContain("kick off the migration")
    )
    let v: string | null = null
    act(() => {
      v = result.current.recall("up", { value: "", caretAtStart: true })
    })
    expect(v).toBe("kick off the migration")
  })
})
