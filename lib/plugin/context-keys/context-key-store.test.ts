import {
  setContextKey,
  setContextKeys,
  deleteContextKey,
  getContextKeySnapshot,
  getContextKeyRevision,
  subscribeContextKeys,
  evaluateContextWhen,
  useContextKeyStore,
  __resetContextKeysForTesting,
} from "./context-key-store"

describe("context-key-store", () => {
  beforeEach(() => __resetContextKeysForTesting())

  it("starts empty with revision 0", () => {
    expect(getContextKeySnapshot()).toEqual({})
    expect(getContextKeyRevision()).toBe(0)
  })

  it("sets and reads a single key", () => {
    setContextKey("chat.active", true)
    expect(getContextKeySnapshot()["chat.active"]).toBe(true)
    expect(getContextKeyRevision()).toBe(1)
  })

  it("does not bump the revision when the value is unchanged", () => {
    setContextKey("chat.active", true)
    const rev = getContextKeyRevision()
    setContextKey("chat.active", true)
    expect(getContextKeyRevision()).toBe(rev)
  })

  it("batch-sets keys with a single revision bump", () => {
    setContextKeys({ "chat.active": true, "platform.tauri": true, "route.settings": false })
    expect(getContextKeyRevision()).toBe(1)
    expect(getContextKeySnapshot()).toMatchObject({
      "chat.active": true,
      "platform.tauri": true,
      "route.settings": false,
    })
  })

  it("batch-set is a no-op (no revision bump) when nothing changes", () => {
    setContextKeys({ a: true })
    const rev = getContextKeyRevision()
    setContextKeys({ a: true })
    expect(getContextKeyRevision()).toBe(rev)
  })

  it("deletes a key", () => {
    setContextKey("x", true)
    deleteContextKey("x")
    expect("x" in getContextKeySnapshot()).toBe(false)
    deleteContextKey("x") // idempotent — no throw, no bump
  })

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const calls: number[] = []
    const unsub = subscribeContextKeys(() => calls.push(getContextKeyRevision()))
    setContextKey("a", true)
    setContextKey("b", true)
    unsub()
    setContextKey("c", true)
    expect(calls).toEqual([1, 2])
  })

  it("supports string and numeric context values", () => {
    setContextKey("model.id", "claude-opus-4-8")
    setContextKey("chat.messageCount", 3)
    expect(getContextKeySnapshot()["model.id"]).toBe("claude-opus-4-8")
    expect(getContextKeySnapshot()["chat.messageCount"]).toBe(3)
  })

  describe("evaluateContextWhen", () => {
    it("returns true for an absent clause", () => {
      expect(evaluateContextWhen(undefined)).toBe(true)
      expect(evaluateContextWhen("")).toBe(true)
    })

    it("reads the live store by default", () => {
      setContextKeys({ "chat.active": true, "chat.streaming": false })
      expect(evaluateContextWhen("chat.active && !chat.streaming")).toBe(true)
      setContextKey("chat.streaming", true)
      expect(evaluateContextWhen("chat.active && !chat.streaming")).toBe(false)
    })

    it("accepts an explicit snapshot", () => {
      expect(evaluateContextWhen("a", { a: true })).toBe(true)
      expect(evaluateContextWhen("a", { a: false })).toBe(false)
    })

    it("treats a string value as truthy when non-empty", () => {
      setContextKey("model.id", "x")
      expect(evaluateContextWhen("model.id")).toBe(true)
      setContextKey("model.id", "")
      expect(evaluateContextWhen("model.id")).toBe(false)
    })

    it("fail-closed: a malformed clause hides the item instead of throwing", () => {
      expect(evaluateContextWhen("a &&")).toBe(false)
      expect(evaluateContextWhen("@@@")).toBe(false)
    })
  })

  it("exposes the underlying zustand store for React subscription", () => {
    const before = useContextKeyStore.getState().revision
    setContextKey("k", true)
    expect(useContextKeyStore.getState().revision).toBe(before + 1)
  })

  it("reset() clears all keys and bumps the revision", () => {
    setContextKeys({ a: true, b: true })
    const rev = getContextKeyRevision()
    useContextKeyStore.getState().reset()
    expect(getContextKeySnapshot()).toEqual({})
    expect(getContextKeyRevision()).toBe(rev + 1)
  })
})
