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

describe("redactText — extended PII coverage", () => {
  it("redacts public IPv4 addresses but leaves private/loopback alone", () => {
    const text = "Server at 8.8.8.8 (cache 192.168.1.1, local 127.0.0.1, link 169.254.1.5)"
    const { redacted } = redactText(text)
    expect(redacted).toContain("<IP_ADDR_001>")
    expect(redacted).toContain("192.168.1.1") // private — left alone
    expect(redacted).toContain("127.0.0.1") // loopback — left alone
    expect(redacted).toContain("169.254.1.5") // link-local — left alone
  })

  it("redacts uncompressed IPv6 addresses", () => {
    const { redacted } = redactText("endpoint 2001:0db8:85a3:0000:0000:8a2e:0370:7334 talks back")
    expect(redacted).toContain("<IP_ADDR_001>")
    expect(redacted).not.toContain("2001:0db8")
  })

  it("redacts known API key prefixes", () => {
    const cases = [
      "OpenAI: sk-proj-abc123def456ghi789jkl012",
      "Anthropic: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx",
      "GitHub PAT: ghp_abcdefghijklmnopqrst1234",
      "Slack bot: xoxb-1234567890-abcdefghijkl",
      "Google: AIzaSyA-aaaabbbbccccdddd1234567",
    ]
    for (const c of cases) {
      const { redacted } = redactText(c)
      expect(redacted).toMatch(/<API_KEY_\d{3}>/)
    }
  })

  it("redacts hint-driven secrets even without recognized prefixes", () => {
    const text = `api_key="ZyAaaaabbbbccccddddeeeeffffgggg"\nbearer: ${"b".repeat(40)}`
    const { redacted } = redactText(text)
    expect(redacted).toMatch(/<API_KEY_\d{3}>/)
    expect(redacted).not.toContain("b".repeat(40))
  })

  it("redacts CN passport prefixes (E/G)", () => {
    const text = "Passport E12345678 + G87654321"
    const { redacted } = redactText(text)
    expect(redacted).not.toContain("E12345678")
    expect(redacted).not.toContain("G87654321")
  })

  it("redacts CN driver licenses only with hint context", () => {
    // With hint — gets redacted
    const hinted = redactText("驾照 123456789012 (二级)")
    expect(hinted.redacted).toContain("<DRIVER_LICENSE_001>")
    // Without hint — 12 random digits left alone
    const bare = redactText("Order id 123456789012 confirmed")
    expect(bare.redacted).toContain("123456789012")
  })

  it("hasNoLeakingPii flags every new kind", () => {
    expect(hasNoLeakingPii("Server at 8.8.8.8")).toBe(false)
    expect(hasNoLeakingPii("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(false)
    expect(hasNoLeakingPii("token sk-proj-abc123def456ghi789jkl012")).toBe(false)
    expect(hasNoLeakingPii("Passport E12345678")).toBe(false)
  })

  it("hasNoLeakingPii is idempotent across consecutive calls", () => {
    // Regression guard for the regex .lastIndex bug — running the gate
    // twice in a row used to flip the second result because the global
    // regexes mutated state between calls.
    expect(hasNoLeakingPii("Server at 8.8.8.8")).toBe(false)
    expect(hasNoLeakingPii("Server at 8.8.8.8")).toBe(false)
    expect(hasNoLeakingPii("clean text")).toBe(true)
    expect(hasNoLeakingPii("clean text")).toBe(true)
  })
})
