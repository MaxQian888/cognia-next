/** @jest-environment jsdom */

import {
  clearDismiss,
  DISMISS_TTL_MS,
  hashSet,
  msUntilDismissExpiry,
  readDismiss,
  safeStorage,
  writeDismiss,
} from "./notice-dismiss"

const KEY = "test.dismiss"

/** Minimal in-memory Storage — lets the throwing cases be exercised directly. */
function memoryStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
    ...overrides,
  } as Storage
}

describe("hashSet", () => {
  it("is order-independent so Dexie row order cannot change the identity", () => {
    expect(hashSet(["b", "a", "c"])).toBe(hashSet(["c", "b", "a"]))
  })

  it("distinguishes different sets", () => {
    expect(hashSet(["a", "b"])).not.toBe(hashSet(["a", "c"]))
  })

  it("does not mutate the input", () => {
    const ids = ["b", "a"]
    hashSet(ids)
    expect(ids).toEqual(["b", "a"])
  })

  it("hashes the empty set to the empty string", () => {
    expect(hashSet([])).toBe("")
  })
})

describe("safeStorage", () => {
  it("returns the matching window storage", () => {
    expect(safeStorage("local")).toBe(window.localStorage)
    expect(safeStorage("session")).toBe(window.sessionStorage)
  })

  it("hands back a store the read/write helpers accept", () => {
    const storage = safeStorage("session")
    writeDismiss(KEY, "round-trip", storage)
    expect(readDismiss(KEY, storage)).toMatchObject({ hash: "round-trip" })
    clearDismiss(KEY, storage)
  })
})

describe("readDismiss / writeDismiss / clearDismiss", () => {
  it("round-trips a snapshot", () => {
    const storage = memoryStorage()
    writeDismiss(KEY, "a|b", storage)
    expect(readDismiss(KEY, storage)).toEqual({ hash: "a|b", at: expect.any(Number) })
  })

  it("treats a null storage as a no-op on every operation", () => {
    expect(readDismiss(KEY, null)).toBeNull()
    expect(() => writeDismiss(KEY, "a", null)).not.toThrow()
    expect(() => clearDismiss(KEY, null)).not.toThrow()
  })

  it("returns null for an absent key", () => {
    expect(readDismiss(KEY, memoryStorage())).toBeNull()
  })

  it("returns null for unparseable JSON rather than throwing", () => {
    const storage = memoryStorage()
    storage.setItem(KEY, "{not json")
    expect(readDismiss(KEY, storage)).toBeNull()
  })

  it("rejects a structurally wrong payload", () => {
    const storage = memoryStorage()
    storage.setItem(KEY, JSON.stringify({ hash: 42, at: "soon" }))
    expect(readDismiss(KEY, storage)).toBeNull()
  })

  it("returns null when the read itself throws", () => {
    const storage = memoryStorage({
      getItem: () => {
        throw new Error("blocked")
      },
    })
    expect(readDismiss(KEY, storage)).toBeNull()
  })

  it("swallows a rejected write so a full quota cannot break the notice", () => {
    const storage = memoryStorage({
      setItem: () => {
        throw new Error("quota")
      },
    })
    expect(() => writeDismiss(KEY, "a", storage)).not.toThrow()
  })

  it("clears a stored snapshot", () => {
    const storage = memoryStorage()
    writeDismiss(KEY, "a", storage)
    clearDismiss(KEY, storage)
    expect(readDismiss(KEY, storage)).toBeNull()
  })

  it("swallows a rejected clear", () => {
    const storage = memoryStorage({
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    expect(() => clearDismiss(KEY, storage)).not.toThrow()
  })
})

describe("msUntilDismissExpiry", () => {
  it("counts down from the snapshot timestamp", () => {
    expect(msUntilDismissExpiry({ hash: "a", at: 1_000 }, 1_000)).toBe(DISMISS_TTL_MS)
    expect(msUntilDismissExpiry({ hash: "a", at: 1_000 }, 1_000 + 60_000)).toBe(
      DISMISS_TTL_MS - 60_000
    )
  })

  it("floors at zero once expired instead of going negative", () => {
    expect(msUntilDismissExpiry({ hash: "a", at: 0 }, DISMISS_TTL_MS * 5)).toBe(0)
  })
})
