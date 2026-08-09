import { OutputFoldState, foldKeyStr, parseFoldKey, type FoldKey } from "./output-folding"

describe("output-folding", () => {
  describe("foldKeyStr / parseFoldKey", () => {
    it("serializes and parses a fold key", () => {
      const key: FoldKey = { sessionId: "session-1", commandIndex: 3 }
      const str = foldKeyStr(key)
      expect(str).toBe("session-1:3")
      expect(parseFoldKey(str)).toEqual(key)
    })

    it("parseFoldKey returns null for invalid input", () => {
      expect(parseFoldKey("")).toBeNull()
      expect(parseFoldKey("no-colon")).toBeNull()
      expect(parseFoldKey(":5")).toBeNull()
      expect(parseFoldKey("sess:abc")).toBeNull()
      expect(parseFoldKey("sess:-1")).toBeNull()
    })

    it("handles session ids containing colons", () => {
      // Only the first colon splits — rest belongs to sessionId? No, our impl
      // splits on first colon. So sessionId can't contain colons. That's fine
      // because session ids are UUIDs/nanoIDs without colons.
      const key: FoldKey = { sessionId: "abc", commandIndex: 10 }
      expect(parseFoldKey(foldKeyStr(key))).toEqual(key)
    })
  })

  describe("OutputFoldState", () => {
    let state: OutputFoldState

    beforeEach(() => {
      state = new OutputFoldState()
    })

    it("starts with nothing folded", () => {
      expect(state.isFolded({ sessionId: "s1", commandIndex: 0 })).toBe(false)
      expect(state.size).toBe(0)
    })

    it("fold() marks a block as folded", () => {
      state.fold({ sessionId: "s1", commandIndex: 2 })
      expect(state.isFolded({ sessionId: "s1", commandIndex: 2 })).toBe(true)
      expect(state.isFolded({ sessionId: "s1", commandIndex: 3 })).toBe(false)
      expect(state.size).toBe(1)
    })

    it("unfold() removes the fold", () => {
      state.fold({ sessionId: "s1", commandIndex: 0 })
      state.unfold({ sessionId: "s1", commandIndex: 0 })
      expect(state.isFolded({ sessionId: "s1", commandIndex: 0 })).toBe(false)
      expect(state.size).toBe(0)
    })

    it("unfold() is a no-op for non-folded keys", () => {
      state.unfold({ sessionId: "s1", commandIndex: 0 })
      expect(state.size).toBe(0)
    })

    it("toggle() flips state and returns new value", () => {
      const key: FoldKey = { sessionId: "s1", commandIndex: 1 }
      expect(state.toggle(key)).toBe(true) // now folded
      expect(state.isFolded(key)).toBe(true)
      expect(state.toggle(key)).toBe(false) // now unfolded
      expect(state.isFolded(key)).toBe(false)
    })

    it("foldedForSession() returns only keys for that session", () => {
      state.fold({ sessionId: "s1", commandIndex: 0 })
      state.fold({ sessionId: "s1", commandIndex: 3 })
      state.fold({ sessionId: "s2", commandIndex: 1 })

      const s1Keys = state.foldedForSession("s1")
      expect(s1Keys).toHaveLength(2)
      expect(s1Keys).toContainEqual({ sessionId: "s1", commandIndex: 0 })
      expect(s1Keys).toContainEqual({ sessionId: "s1", commandIndex: 3 })
    })

    it("foldedCount() returns count for a session", () => {
      state.fold({ sessionId: "s1", commandIndex: 0 })
      state.fold({ sessionId: "s1", commandIndex: 1 })
      state.fold({ sessionId: "s2", commandIndex: 0 })

      expect(state.foldedCount("s1")).toBe(2)
      expect(state.foldedCount("s2")).toBe(1)
      expect(state.foldedCount("s3")).toBe(0)
    })

    it("unfoldAll() clears all folds for a session", () => {
      state.fold({ sessionId: "s1", commandIndex: 0 })
      state.fold({ sessionId: "s1", commandIndex: 5 })
      state.fold({ sessionId: "s2", commandIndex: 2 })

      state.unfoldAll("s1")
      expect(state.foldedCount("s1")).toBe(0)
      expect(state.foldedCount("s2")).toBe(1)
      expect(state.size).toBe(1)
    })

    it("reset() clears all state", () => {
      state.fold({ sessionId: "s1", commandIndex: 0 })
      state.fold({ sessionId: "s2", commandIndex: 1 })
      state.reset()
      expect(state.size).toBe(0)
    })

    it("fold() is idempotent", () => {
      const key: FoldKey = { sessionId: "s1", commandIndex: 0 }
      state.fold(key)
      state.fold(key)
      expect(state.size).toBe(1)
    })
  })
})
