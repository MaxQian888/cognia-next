import {
  __countNumericActionsForTesting,
  __resetNumericActionRegistryForTesting,
  consumeNumericAction,
  __peekNumericActionForTesting,
  setNumericAction,
} from "./numeric-action-registry"

beforeEach(() => {
  __resetNumericActionRegistryForTesting()
})

describe("setNumericAction", () => {
  it("stores a numeric → actionId mapping", () => {
    setNumericAction("conv1", 1, "wc:a", 1000)
    expect(__peekNumericActionForTesting("conv1", 1, 1010)).toBe("wc:a")
  })

  it("overwrites a prior binding for the same numeric on the same conversation", () => {
    setNumericAction("conv1", 1, "wc:old", 1000)
    setNumericAction("conv1", 1, "wc:new", 1010)
    expect(__peekNumericActionForTesting("conv1", 1, 1020)).toBe("wc:new")
    expect(__countNumericActionsForTesting("conv1")).toBe(1)
  })

  it("isolates bindings per conversation", () => {
    setNumericAction("a", 1, "wc:a1")
    setNumericAction("b", 1, "wc:b1")
    expect(__peekNumericActionForTesting("a", 1)).toBe("wc:a1")
    expect(__peekNumericActionForTesting("b", 1)).toBe("wc:b1")
  })

  it("trims to capacity 9 per conversation (digits 1-9), evicting the oldest", () => {
    const conv = "conv-capacity"
    for (let i = 1; i <= 12; i++) {
      setNumericAction(conv, i, `wc:${i}`, 1000 + i)
    }
    // Numerics 1-3 should have been evicted to fit the cap.
    expect(__peekNumericActionForTesting(conv, 1, 2000)).toBeUndefined()
    expect(__peekNumericActionForTesting(conv, 2, 2000)).toBeUndefined()
    expect(__peekNumericActionForTesting(conv, 3, 2000)).toBeUndefined()
    expect(__peekNumericActionForTesting(conv, 4, 2000)).toBe("wc:4")
    expect(__peekNumericActionForTesting(conv, 12, 2000)).toBe("wc:12")
    expect(__countNumericActionsForTesting(conv)).toBe(9)
  })
})

describe("__peekNumericActionForTesting TTL", () => {
  it("returns undefined once a binding's 90s TTL expires", () => {
    setNumericAction("conv", 1, "wc:a", 1_000)
    expect(__peekNumericActionForTesting("conv", 1, 1_000 + 89_000)).toBe("wc:a")
    expect(__peekNumericActionForTesting("conv", 1, 1_000 + 91_000)).toBeUndefined()
  })

  it("evicts expired entries during peek so capacity doesn't grow unbounded", () => {
    setNumericAction("conv", 1, "wc:a", 0)
    expect(__countNumericActionsForTesting("conv")).toBe(1)
    __peekNumericActionForTesting("conv", 99, 200_000) // any peek after TTL
    expect(__countNumericActionsForTesting("conv")).toBe(0)
  })
})

describe("consumeNumericAction", () => {
  it("returns + removes the actionId so a second consume misses", () => {
    setNumericAction("conv", 1, "wc:a", 1_000)
    expect(consumeNumericAction("conv", 1, 1_000)).toBe("wc:a")
    expect(consumeNumericAction("conv", 1, 1_010)).toBeUndefined()
  })

  it("returns undefined for unknown numeric without disturbing other bindings", () => {
    setNumericAction("conv", 1, "wc:a", 1_000)
    setNumericAction("conv", 2, "wc:b", 1_000)
    expect(consumeNumericAction("conv", 5, 1_005)).toBeUndefined()
    expect(__peekNumericActionForTesting("conv", 1, 1_006)).toBe("wc:a")
    expect(__peekNumericActionForTesting("conv", 2, 1_006)).toBe("wc:b")
  })

  it("treats an expired binding as not-present and prunes it", () => {
    setNumericAction("conv", 1, "wc:a", 0)
    expect(consumeNumericAction("conv", 1, 200_000)).toBeUndefined()
    expect(__countNumericActionsForTesting("conv")).toBe(0)
  })
})
