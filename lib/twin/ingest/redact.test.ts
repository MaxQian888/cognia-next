/**
 * Coverage for `redact.ts`. Per the plan's red-line testing rules
 * (§5.4 of the brainstorming), three properties hold for every input:
 *   1. round-trip symmetry — `unredactText(redactText(x).redacted, …) === x`
 *   2. coverage ≥ 95 % across the email / phone / id / bank-card classes
 *   3. zero PII in the redacted output (`hasNoLeakingPii` returns true)
 */

import { hasNoLeakingPii, redactText, unredactText } from "./redact"

describe("redactText", () => {
  it("redacts emails and round-trips perfectly", () => {
    const original = "Contact alice@example.com or bob@firm.co.uk for help."
    const { redacted, map } = redactText(original)
    expect(redacted).not.toContain("alice@example.com")
    expect(redacted).not.toContain("bob@firm.co.uk")
    expect(redacted.match(/<EMAIL_\d{3}>/g)?.length).toBe(2)
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("redacts CN national IDs (17 digits + check char)", () => {
    // Both fixtures are 18 characters total: 17 digits + (digit | X).
    const original = "ID: 110105199001011234, also 11010519900101111X."
    const { redacted, map } = redactText(original)
    expect(redacted).toContain("<CN_ID_001>")
    expect(redacted).toContain("<CN_ID_002>")
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("redacts Luhn-valid bank-card numbers but leaves random 16-digit non-cards alone", () => {
    // 4111111111111111 is the well-known Visa test card (Luhn-valid).
    // 1234567890123456 fails Luhn.
    const original = "Card 4111111111111111 vs gibberish 1234567890123456"
    const { redacted, map } = redactText(original)
    expect(redacted).toContain("<BANK_CARD_001>")
    expect(redacted).toContain("1234567890123456")
    expect(map["<BANK_CARD_001>"].original).toBe("4111111111111111")
  })

  it("redacts CN-mobile-shaped phone numbers", () => {
    const original = "Call 13800138000 or +14155551212."
    const { redacted } = redactText(original)
    expect(redacted).toContain("<PHONE_")
    expect(redacted).not.toContain("13800138000")
  })

  it("dedupes — same value gets the same placeholder", () => {
    const original = "Email alice@example.com twice: alice@example.com."
    const { redacted, map } = redactText(original)
    expect(redacted.match(/<EMAIL_001>/g)?.length).toBe(2)
    expect(Object.keys(map)).toHaveLength(1)
  })

  it("scrubs name hints (chat speakers / signature) word-bounded", () => {
    const original = "Alice approved this. Note: Alice is on PTO. (alice@x.io)"
    const { redacted, map } = redactText(original, ["Alice"])
    // Two NAME hits + 1 EMAIL hit; the literal word "alice" inside the
    // email local-part stays inside the EMAIL placeholder, not double-tokenized.
    // `[\s\S]` instead of `s` flag for ES2017 compatibility.
    expect(redacted).toMatch(/<NAME_001>[\s\S]*<NAME_001>[\s\S]*<EMAIL_001>/)
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("survives empty input", () => {
    const { redacted, map } = redactText("")
    expect(redacted).toBe("")
    expect(map).toEqual({})
  })

  it("ignores empty / whitespace-only name hints", () => {
    const { redacted } = redactText("Alice approved.", ["", "  "])
    expect(redacted).toContain("Alice")
  })

  it("escapes regex metacharacters in name hints", () => {
    // "C++ team" contains regex metacharacters; the call should not throw.
    const { redacted, map } = redactText("Greetings from the C++ team.", ["C++ team"])
    expect(redacted).toContain("<NAME_001>")
    expect(unredactText(redacted, map)).toBe("Greetings from the C++ team.")
  })

  it("PII coverage holds across a 100-input bulk fixture", () => {
    const samples = Array.from({ length: 25 }, (_, i) => {
      const local = `user${i}`
      const email = `${local}@example.com`
      const phone = `1${(38000138000 + i).toString().padStart(10, "0")}`
      const id = `11010520${(20000101 + i).toString().padStart(10, "0")}1`
      // 4111... is Luhn valid; vary suffix while preserving check digit.
      const card = "4111111111111111"
      return [`Hi ${email}`, `Reach me on ${phone}`, `ID ${id}`, `Card ${card}`]
    }).flat()
    const total = samples.length
    let leaks = 0
    for (const sample of samples) {
      const { redacted } = redactText(sample)
      if (!hasNoLeakingPii(redacted)) leaks += 1
    }
    expect(leaks / total).toBeLessThan(0.05)
  })

  it("hasNoLeakingPii flags raw text", () => {
    expect(hasNoLeakingPii("plain prose with no PII")).toBe(true)
    expect(hasNoLeakingPii("see alice@example.com")).toBe(false)
    expect(hasNoLeakingPii("ID 11010519900101111X")).toBe(false)
    // Luhn-valid bank card.
    expect(hasNoLeakingPii("Card: 4111111111111111")).toBe(false)
    // Not Luhn-valid → not flagged.
    expect(hasNoLeakingPii("Lottery draw 1234567890123456")).toBe(true)
  })

  it("unredactText leaves unknown placeholders untouched", () => {
    const out = unredactText("hello <UNKNOWN_001>", {})
    expect(out).toBe("hello <UNKNOWN_001>")
  })
})
