import {
  registerUndoSnapshot,
  getUndoSnapshot,
  hasUndoSnapshot,
  clearUndoSnapshot,
  clearUndoSnapshots,
  __resetUndoRegistryForTesting,
} from "./compaction-undo"

beforeEach(() => __resetUndoRegistryForTesting())

describe("compaction-undo registry", () => {
  it("registers and reads a snapshot by token", () => {
    registerUndoSnapshot({
      token: "compact-1",
      strategy: "summary",
      tokensBefore: 45000,
      tokensAfter: 8000,
      createdAt: 123,
      snapshot: [{ role: "user", content: "m0" }],
    })
    expect(hasUndoSnapshot("compact-1")).toBe(true)
    const e = getUndoSnapshot("compact-1")
    expect(e?.strategy).toBe("summary")
    expect(e?.snapshot).toHaveLength(1)
  })

  it("reports absent tokens", () => {
    expect(hasUndoSnapshot("nope")).toBe(false)
    expect(getUndoSnapshot("nope")).toBeUndefined()
  })

  it("clears a single token", () => {
    registerUndoSnapshot({ token: "a", createdAt: 1, snapshot: [] })
    clearUndoSnapshot("a")
    expect(hasUndoSnapshot("a")).toBe(false)
  })

  it("clears many tokens at once", () => {
    registerUndoSnapshot({ token: "a", createdAt: 1, snapshot: [] })
    registerUndoSnapshot({ token: "b", createdAt: 1, snapshot: [] })
    clearUndoSnapshots(["a", "b"])
    expect(hasUndoSnapshot("a")).toBe(false)
    expect(hasUndoSnapshot("b")).toBe(false)
  })
})
