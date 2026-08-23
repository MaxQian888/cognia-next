import { findingKey, fingerprintFinding, primaryLocationKey, targetKey } from "./fingerprint"

const base = { ruleId: "sql-injection", title: "SQL injection in login" }

describe("fingerprintFinding", () => {
  it("is stable for the same rule and file", () => {
    const a = fingerprintFinding({ ...base, locations: [{ file: "src/db.ts", startLine: 10 }] })
    const b = fingerprintFinding({ ...base, locations: [{ file: "src/db.ts", startLine: 10 }] })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it("survives a line shift from an unrelated edit above the finding", () => {
    const before = fingerprintFinding({
      ...base,
      locations: [{ file: "src/db.ts", startLine: 10 }],
    })
    const after = fingerprintFinding({ ...base, locations: [{ file: "src/db.ts", startLine: 94 }] })
    expect(after).toBe(before)
  })

  it("survives a rescore and a reworded description", () => {
    // Severity, CVSS and prose are not inputs at all — asserted by the fact
    // that the input type has no place to put them.
    const a = fingerprintFinding({ ...base, locations: [{ file: "a.ts" }] })
    const b = fingerprintFinding({ ...base, locations: [{ file: "a.ts" }] })
    expect(a).toBe(b)
  })

  it("survives a retitle when a rule id is present", () => {
    const a = fingerprintFinding({ ...base, locations: [{ file: "a.ts" }] })
    const b = fingerprintFinding({
      ...base,
      title: "SQLi on /login",
      locations: [{ file: "a.ts" }],
    })
    expect(b).toBe(a)
  })

  it("falls back to the title only when there is no rule id", () => {
    const a = fingerprintFinding({ ruleId: "", title: "XSS", locations: [{ file: "a.ts" }] })
    const b = fingerprintFinding({ ruleId: "", title: "Other", locations: [{ file: "a.ts" }] })
    expect(a).not.toBe(b)
  })

  it("separates the same rule in different files", () => {
    const a = fingerprintFinding({ ...base, locations: [{ file: "a.ts" }] })
    const b = fingerprintFinding({ ...base, locations: [{ file: "b.ts" }] })
    expect(a).not.toBe(b)
  })

  it("does not depend on the order locations were reported in", () => {
    const a = fingerprintFinding({ ...base, locations: [{ file: "b.ts" }, { file: "a.ts" }] })
    const b = fingerprintFinding({ ...base, locations: [{ file: "a.ts" }, { file: "b.ts" }] })
    expect(a).toBe(b)
  })

  it("normalizes path separators and case", () => {
    const a = fingerprintFinding({ ...base, locations: [{ file: "src\\Db.ts" }] })
    const b = fingerprintFinding({ ...base, locations: [{ file: "src/db.ts" }] })
    expect(a).toBe(b)
  })

  it("keys a black-box finding on its endpoint and method", () => {
    const a = fingerprintFinding({ ...base, locations: [{ endpoint: "/login", method: "post" }] })
    const b = fingerprintFinding({ ...base, locations: [{ endpoint: "/login", method: "POST" }] })
    const c = fingerprintFinding({ ...base, locations: [{ endpoint: "/login", method: "GET" }] })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it("still produces a key for a finding with no location at all", () => {
    expect(fingerprintFinding({ ...base, locations: [] })).toMatch(/^[0-9a-f]{16}$/)
  })

  it("prefers a file over an endpoint when both are present", () => {
    expect(primaryLocationKey([{ endpoint: "/x" }, { file: "a.ts" }])).toBe("file:a.ts")
  })

  it("skips locations that carry neither a file nor an endpoint", () => {
    expect(primaryLocationKey([{ startLine: 3 }, { file: "a.ts" }])).toBe("file:a.ts")
    expect(primaryLocationKey([{ startLine: 3 }])).toBe("")
  })

  it("produces distinct keys across a realistic corpus", () => {
    const seen = new Set<string>()
    for (let index = 0; index < 5000; index += 1) {
      seen.add(fingerprintFinding({ ruleId: `rule-${index}`, title: "t", locations: [] }))
    }
    expect(seen.size).toBe(5000)
  })
})

describe("targetKey", () => {
  it("ignores scheme, case, and trailing slashes", () => {
    expect(targetKey("https://Example.COM/app/")).toBe("example.com/app")
    expect(targetKey("http://example.com/app")).toBe("example.com/app")
  })

  it("keeps a non-default port, which is a different service", () => {
    expect(targetKey("https://example.com:8443/")).toBe("example.com:8443")
    expect(targetKey("https://example.com/")).toBe("example.com")
  })

  it("canonicalizes a filesystem path without throwing", () => {
    expect(targetKey("/Users/me/Repo/")).toBe("/users/me/repo")
    expect(targetKey("C:\\Work\\Repo")).toBe("c:/work/repo")
  })

  it("returns an empty key for an empty target", () => {
    expect(targetKey("")).toBe("")
    expect(targetKey("   ")).toBe("")
  })
})

describe("findingKey", () => {
  it("scopes a fingerprint to its target", () => {
    expect(findingKey("example.com", "abc")).toBe("example.com abc")
    expect(findingKey("staging.example.com", "abc")).not.toBe(findingKey("example.com", "abc"))
  })
})
