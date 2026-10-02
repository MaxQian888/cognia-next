import { describe, expect, it } from "vitest"

import { maskEmail, normalizeEmail } from "./email"

describe("normalizeEmail", () => {
  it("trims, lowercases the domain and keeps the local part and plus tags as typed", () => {
    expect(normalizeEmail("  Alice.Smith+Status@Example.COM ")).toBe(
      "Alice.Smith+Status@example.com"
    )
  })

  it("converts an internationalised domain to punycode", () => {
    expect(normalizeEmail("user@Bücher.Example")).toBe("user@xn--bcher-kva.example")
  })

  it("accepts a trailing dot in the domain consistently", () => {
    expect(normalizeEmail("user@example.com.")).toBe("user@example.com")
  })

  it.each([
    "",
    "plain",
    "@example.com",
    "user@",
    "user@localhost",
    "user@127.0.0.1",
    "user@[127.0.0.1]",
    '"quoted"@example.com',
    "spaced name@example.com",
    "user@exa mple.com",
    "user@example.com:8080",
    "user@example.com/path",
    "dots..twice@example.com",
    ".leading@example.com",
    "ünïcode@example.com",
    `${"a".repeat(65)}@example.com`,
    "user@-bad-.example",
  ])("refuses %j", (input) => {
    expect(normalizeEmail(input)).toBeNull()
  })
})

describe("maskEmail", () => {
  it("shows only the first character and the domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a•••@example.com")
    expect(maskEmail("broken")).toBe("•••")
  })
})
