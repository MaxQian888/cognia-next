import {
  classifyError,
  isConnectivityCategory,
  type ErrorCategory,
  type RecoveryKind,
} from "./classify-error"

function err(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

describe("classifyError", () => {
  it("returns unknown/reset when there is no error", () => {
    expect(classifyError(undefined)).toEqual({ category: "unknown", recoveryKind: "reset" })
    expect(classifyError(null)).toEqual({ category: "unknown", recoveryKind: "reset" })
  })

  describe("chunk-load detection → reload", () => {
    const cases: Array<[string, string]> = [
      ["ChunkLoadError", "Loading chunk 42 failed."],
      ["Error", "Loading CSS chunk 7 failed"],
      ["TypeError", "error loading dynamically imported module: /_next/x.js"],
      ["TypeError", "Failed to fetch dynamically imported module"],
    ]
    it.each(cases)("classifies %s / %s as chunk-load", (name, message) => {
      expect(classifyError(err(name, message))).toEqual({
        category: "chunk-load",
        recoveryKind: "reload",
      })
    })

    it("treats chunk-load as reload even while offline (manifest re-fetch wins)", () => {
      const result = classifyError(err("ChunkLoadError", "Loading chunk failed"), { online: false })
      expect(result.category).toBe("chunk-load")
      expect(result.recoveryKind).toBe("reload")
    })
  })

  describe("offline detection → retry-online", () => {
    it("classifies any error as offline when online === false", () => {
      expect(classifyError(err("Error", "boom"), { online: false })).toEqual({
        category: "offline",
        recoveryKind: "retry-online",
      })
    })

    it("classifies a network-shaped error as offline when offline", () => {
      expect(classifyError(err("TypeError", "Failed to fetch"), { online: false })).toEqual({
        category: "offline",
        recoveryKind: "retry-online",
      })
    })
  })

  describe("network detection → retry-online (while online/unknown)", () => {
    const cases: Array<[string, string]> = [
      ["TypeError", "Failed to fetch"],
      ["Error", "NetworkError when attempting to fetch resource"],
      ["Error", "net::ERR_NETWORK_CHANGED"],
      ["Error", "Network request failed"],
      ["TypeError", "Load failed"],
      ["Error", "The operation timed out"],
    ]
    it.each(cases)("classifies %s / %s as network", (name, message) => {
      expect(classifyError(err(name, message), { online: true })).toEqual({
        category: "network",
        recoveryKind: "retry-online",
      })
    })

    it("still classifies as network when online is unknown", () => {
      expect(classifyError(err("TypeError", "Failed to fetch")).category).toBe("network")
    })
  })

  describe("render fallback → reset", () => {
    it("classifies an arbitrary runtime error as render/reset", () => {
      expect(classifyError(err("TypeError", "Cannot read properties of undefined"))).toEqual({
        category: "render",
        recoveryKind: "reset",
      })
    })

    it("is case-insensitive across name and message", () => {
      expect(classifyError(err("CHUNKLOADERROR", "X")).category).toBe("chunk-load")
    })

    it("tolerates an empty message", () => {
      expect(classifyError(err("Error", "")).category).toBe("render")
    })

    it("tolerates an error missing name and message", () => {
      const bare = { name: undefined, message: undefined } as unknown as Error
      expect(classifyError(bare)).toEqual({ category: "render", recoveryKind: "reset" })
    })
  })
})

describe("isConnectivityCategory", () => {
  const expectations: Array<[ErrorCategory, boolean]> = [
    ["offline", true],
    ["network", true],
    ["chunk-load", false],
    ["render", false],
    ["unknown", false],
  ]
  it.each(expectations)("%s → %s", (category, expected) => {
    expect(isConnectivityCategory(category)).toBe(expected)
  })
})

// Type-level guard: keep RecoveryKind exhaustive in tests.
const _kinds: RecoveryKind[] = ["reload", "retry-online", "reset"]
void _kinds
