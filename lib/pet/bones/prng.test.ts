import { fnv1a, mulberry32, seededRng, pick, randInt, shuffle } from "./prng"

describe("fnv1a", () => {
  it("is deterministic and returns an unsigned 32-bit int", () => {
    const a = fnv1a("hello")
    expect(a).toBe(fnv1a("hello"))
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(0xffffffff)
  })

  it("differs for different inputs", () => {
    expect(fnv1a("a")).not.toBe(fnv1a("b"))
  })
})

describe("mulberry32", () => {
  it("produces a deterministic stream in [0,1)", () => {
    const r1 = mulberry32(123)
    const r2 = mulberry32(123)
    const s1 = [r1(), r1(), r1()]
    const s2 = [r2(), r2(), r2()]
    expect(s1).toEqual(s2)
    for (const v of s1) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe("seededRng", () => {
  it("is stable for the same salt+key and varies otherwise", () => {
    const a = seededRng("salt", "acct")()
    const b = seededRng("salt", "acct")()
    expect(a).toBe(b)
    expect(seededRng("salt", "acct2")()).not.toBe(a)
  })
})

describe("pick / randInt / shuffle", () => {
  it("pick stays within the list", () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 20; i++) expect(["x", "y", "z"]).toContain(pick(rng, ["x", "y", "z"]))
  })

  it("randInt stays within the inclusive range", () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 50; i++) {
      const n = randInt(rng, 3, 6)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(6)
    }
  })

  it("shuffle is a permutation and deterministic for a seed", () => {
    const input = [1, 2, 3, 4, 5]
    const a = shuffle(mulberry32(42), input)
    const b = shuffle(mulberry32(42), input)
    expect(a).toEqual(b)
    expect([...a].sort()).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5]) // not mutated
  })
})
