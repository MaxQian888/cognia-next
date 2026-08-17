import { FNV1A_OFFSET_BASIS, fnv1a32 } from "./fnv1a"

describe("fnv1a32", () => {
  it("returns the offset basis for the empty string", () => {
    expect(fnv1a32("")).toBe(FNV1A_OFFSET_BASIS)
  })

  it("matches the reference FNV-1a 32-bit vectors", () => {
    // Reference vectors from the FNV spec (http://www.isthe.com/chongo/tech/comp/fnv/).
    expect(fnv1a32("a")).toBe(0xe40c292c)
    expect(fnv1a32("foobar")).toBe(0xbf9cf968)
  })

  it("is deterministic and always an unsigned 32-bit integer", () => {
    const first = fnv1a32("job-1#0")
    const second = fnv1a32("job-1#0")
    expect(first).toBe(second)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(first)).toBe(true)
  })

  it("changes with the seed and with the input", () => {
    expect(fnv1a32("x", 1)).not.toBe(fnv1a32("x", 2))
    expect(fnv1a32("x")).not.toBe(fnv1a32("y"))
  })
})
