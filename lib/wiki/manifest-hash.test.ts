import { hashFileHashes } from "./manifest-hash"

describe("hashFileHashes", () => {
  it("is stable across calls and independent of key insertion order", () => {
    const a = { "lib/a.ts": "sha-a", "lib/b.ts": "sha-b" }
    const b = { "lib/b.ts": "sha-b", "lib/a.ts": "sha-a" }

    expect(hashFileHashes(a)).toBe(hashFileHashes(a))
    expect(hashFileHashes(a)).toBe(hashFileHashes(b))
  })

  it("changes when a file's content hash changes", () => {
    const before = hashFileHashes({ "lib/a.ts": "sha-a" })
    const after = hashFileHashes({ "lib/a.ts": "sha-a-modified" })
    expect(after).not.toBe(before)
  })

  it("changes when a file is added or removed", () => {
    const one = hashFileHashes({ "lib/a.ts": "sha-a" })
    const two = hashFileHashes({ "lib/a.ts": "sha-a", "lib/b.ts": "sha-b" })
    expect(two).not.toBe(one)
    expect(hashFileHashes({ "lib/b.ts": "sha-b" })).not.toBe(one)
  })

  it("gives an empty map a real, self-consistent value", () => {
    expect(hashFileHashes({})).toBe(hashFileHashes({}))
    expect(hashFileHashes({})).toMatch(/^[0-9a-f]{8}$/)
  })

  it("does not collide when a separator is shifted between path and digest", () => {
    // The whole reason the fields are NUL-delimited: without a separator these
    // two maps serialize to the same character stream.
    expect(hashFileHashes({ ab: "c" })).not.toBe(hashFileHashes({ a: "bc" }))
  })

  it("distinguishes a repeated digest across different paths", () => {
    const shared = hashFileHashes({ "a.ts": "same", "b.ts": "same" })
    const single = hashFileHashes({ "a.ts": "same" })
    expect(shared).not.toBe(single)
  })

  it("always returns 8 lowercase hex characters", () => {
    const fixtures: Record<string, string>[] = [{}, { a: "1" }, { "a/b/c.ts": "f".repeat(64) }]
    for (const fixture of fixtures) {
      expect(hashFileHashes(fixture)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})
