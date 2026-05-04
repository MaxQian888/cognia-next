/**
 * Coverage for `lib/wiki/merkle.ts` — sha256 + merkle-map manipulation.
 */

import { buildMerkleMap, dropPaths, hashContent, refreshSubset } from "./merkle"

describe("hashContent", () => {
  it("produces a 64-char hex digest", async () => {
    const h = await hashContent("hello")
    expect(h).toHaveLength(64)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it("matches the canonical SHA-256 of an empty string", async () => {
    expect(await hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("matches the canonical SHA-256 of 'abc'", async () => {
    expect(await hashContent("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("returns identical hashes for identical inputs", async () => {
    const a = await hashContent("same content")
    const b = await hashContent("same content")
    expect(a).toBe(b)
  })

  it("returns different hashes for different inputs (avalanche)", async () => {
    const a = await hashContent("hello")
    const b = await hashContent("hellp")
    expect(a).not.toBe(b)
  })
})

describe("buildMerkleMap", () => {
  it("returns an empty map for empty input", async () => {
    expect(await buildMerkleMap([])).toEqual({})
  })

  it("hashes every file path → content pair", async () => {
    const map = await buildMerkleMap([
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "beta" },
    ])
    expect(Object.keys(map).sort()).toEqual(["a.ts", "b.ts"])
    expect(map["a.ts"]).toHaveLength(64)
    expect(map["a.ts"]).not.toEqual(map["b.ts"])
  })

  it("reproduces hashes deterministically across calls", async () => {
    const files = [{ path: "a.ts", content: "x" }]
    expect(await buildMerkleMap(files)).toEqual(await buildMerkleMap(files))
  })
})

describe("refreshSubset", () => {
  it("returns a fresh object (no input mutation)", async () => {
    const existing = { "a.ts": "old" }
    const result = await refreshSubset(existing, [{ path: "a.ts", content: "new" }])
    expect(existing["a.ts"]).toBe("old")
    expect(result["a.ts"]).not.toBe("old")
  })

  it("preserves entries not in the refresh set", async () => {
    const existing = { "a.ts": "h_a", "b.ts": "h_b" }
    const result = await refreshSubset(existing, [{ path: "a.ts", content: "alpha" }])
    expect(result["b.ts"]).toBe("h_b")
    expect(result["a.ts"]).not.toBe("h_a")
  })

  it("adds entries that didn't exist in the previous map", async () => {
    const existing = { "a.ts": "h_a" }
    const result = await refreshSubset(existing, [{ path: "new.ts", content: "x" }])
    expect(result["new.ts"]).toHaveLength(64)
    expect(result["a.ts"]).toBe("h_a")
  })
})

describe("dropPaths", () => {
  it("removes the listed entries", () => {
    const result = dropPaths({ "a.ts": "1", "b.ts": "2", "c.ts": "3" }, ["b.ts"])
    expect(result).toEqual({ "a.ts": "1", "c.ts": "3" })
  })

  it("returns a fresh object (no input mutation)", () => {
    const input = { "a.ts": "1" }
    const result = dropPaths(input, ["a.ts"])
    expect(input["a.ts"]).toBe("1")
    expect(result).toEqual({})
  })

  it("handles empty drop list (returns equivalent map)", () => {
    expect(dropPaths({ "a.ts": "1" }, [])).toEqual({ "a.ts": "1" })
  })

  it("ignores drop entries that aren't in the source map", () => {
    expect(dropPaths({ "a.ts": "1" }, ["b.ts"])).toEqual({ "a.ts": "1" })
  })
})
