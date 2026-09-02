import { credentialAffinityOf } from "./credential-affinity"

describe("credentialAffinityOf", () => {
  it("is stable, prefixed, and distinct per key", () => {
    const a = credentialAffinityOf("sk-one")
    expect(a).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
    expect(credentialAffinityOf("sk-one")).toBe(a)
    expect(credentialAffinityOf("sk-two")).not.toBe(a)
    expect(a).not.toContain("sk-one")
  })

  it("labels a missing credential instead of hashing nothing", () => {
    expect(credentialAffinityOf(undefined)).toBe("keyless")
    expect(credentialAffinityOf("")).toBe("keyless")
  })

  it("matches the FNV-1a reference vector", () => {
    // FNV-1a 64 of "a" is 0xaf63dc4c8601ec8c.
    expect(credentialAffinityOf("a")).toBe("fnv1a64:af63dc4c8601ec8c")
  })
})
