import {
  assertSharedChatClientEnabled,
  isSharedChatBuildEnabled,
  isSharedChatClientEnabled,
  readSharedChatPreference,
  writeSharedChatPreference,
} from "./shared-chat-feature"

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    local: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
    read: (key: string) => map.get(key) ?? null,
  }
}

describe("shared chat client rollout gate", () => {
  it("fails closed in production unless explicitly enabled", () => {
    expect(isSharedChatClientEnabled(undefined, "production")).toBe(false)
    expect(isSharedChatClientEnabled("false", "production")).toBe(false)
    expect(isSharedChatClientEnabled("true", "production")).toBe(true)
    expect(isSharedChatClientEnabled(" TRUE ", "production")).toBe(true)
  })

  it("keeps the feature directly testable", () => {
    expect(isSharedChatClientEnabled(undefined, "test")).toBe(true)
    expect(() => assertSharedChatClientEnabled()).not.toThrow()
  })

  it("reports the build switch separately from the local choice", () => {
    // The settings surface needs these apart to say why the control is off.
    expect(isSharedChatBuildEnabled("true", "production")).toBe(true)
    const off = memoryStore({ "cognia.collab.shared-chat-enabled": "false" })
    expect(isSharedChatBuildEnabled("true", "production")).toBe(true)
    expect(isSharedChatClientEnabled("true", "production", off)).toBe(false)
  })
})

describe("shared chat local preference", () => {
  it("treats a machine that never chose as opted in", () => {
    const store = memoryStore()
    expect(readSharedChatPreference(store)).toBeUndefined()
    expect(isSharedChatClientEnabled("true", "production", store)).toBe(true)
  })

  it("round-trips a choice and forgets it again", () => {
    const store = memoryStore()
    writeSharedChatPreference(false, store)
    expect(readSharedChatPreference(store)).toBe(false)
    writeSharedChatPreference(true, store)
    expect(readSharedChatPreference(store)).toBe(true)
    writeSharedChatPreference(undefined, store)
    expect(readSharedChatPreference(store)).toBeUndefined()
  })

  it("ignores a stored value that is not a boolean", () => {
    const store = memoryStore({ "cognia.collab.shared-chat-enabled": "yes please" })
    expect(readSharedChatPreference(store)).toBeUndefined()
  })

  it("never lets the local choice overrule a build that says no", () => {
    const store = memoryStore()
    writeSharedChatPreference(true, store)
    expect(isSharedChatClientEnabled("false", "production", store)).toBe(false)
    expect(isSharedChatClientEnabled(undefined, "production", store)).toBe(false)
  })

  it("survives storage that throws", () => {
    const hostile = {
      local: {
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {
          throw new Error("blocked")
        },
        removeItem: () => {
          throw new Error("blocked")
        },
      },
    }
    expect(readSharedChatPreference(hostile)).toBeUndefined()
    expect(() => writeSharedChatPreference(false, hostile)).not.toThrow()
    expect(isSharedChatClientEnabled("true", "production", hostile)).toBe(true)
  })
})
