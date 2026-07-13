/**
 * Coverage for `redact.ts`. Per the plan's red-line testing rules
 * (§5.4 of the brainstorming), three properties hold for every input:
 *   1. round-trip symmetry — `unredactText(redactText(x).redacted, …) === x`
 *   2. coverage ≥ 95 % across the email / phone / id / bank-card classes
 *   3. zero PII in the redacted output (`hasNoLeakingPii` returns true)
 */

import {
  PII_KINDS,
  PII_PLACEHOLDER_SOURCE,
  hasNoLeakingPii,
  hasNoLeakingPiiDeep,
  redactText,
  unredactText,
} from "./index"

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

  it("hasNoLeakingPii is order-independent when interleaving clean and dirty text", () => {
    // Stateless guard: a dirty call must never poison the verdict of a later
    // clean call (and vice-versa), regardless of interleaving order.
    expect(hasNoLeakingPii("see alice@example.com")).toBe(false)
    expect(hasNoLeakingPii("perfectly clean prose")).toBe(true)
    expect(hasNoLeakingPii("ID 11010519900101111X")).toBe(false)
    expect(hasNoLeakingPii("more clean prose")).toBe(true)
    expect(hasNoLeakingPii("Card: 4111111111111111")).toBe(false)
    expect(hasNoLeakingPii("nothing to see here")).toBe(true)
  })
})

describe("redactText — hardened secret/PII coverage (T0.1)", () => {
  it("redacts spaced and dashed Luhn-valid bank cards", () => {
    const original = "Card 4111 1111 1111 1111 on file"
    const spaced = redactText(original)
    expect(spaced.redacted).toContain("<BANK_CARD_001>")
    expect(spaced.redacted).not.toContain("4111 1111 1111 1111")
    expect(unredactText(spaced.redacted, spaced.map)).toBe(original)

    const dashed = redactText("Card 4111-1111-1111-1111 on file")
    expect(dashed.redacted).toContain("<BANK_CARD_001>")
    expect(dashed.redacted).not.toContain("4111-1111-1111-1111")

    // A spaced number that fails Luhn is left alone.
    const bad = redactText("Ref 1234 5678 9012 3456 here")
    expect(bad.redacted).toContain("1234 5678 9012 3456")
  })

  it("redacts PEM private-key blocks whole and round-trips", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA2Z3basesixtyfourlines",
      "abcdef0123456789AbCdEf==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n")
    const original = `Here is my key:\n${pem}\nthanks`
    const { redacted, map } = redactText(original)
    expect(redacted).toContain("<PEM_KEY_001>")
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("redacts three-segment JWTs and round-trips", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    const original = `token=${jwt}`
    const { redacted, map } = redactText(original)
    expect(redacted).toContain("<JWT_001>")
    expect(redacted).not.toContain("eyJhbGci")
    // Single placeholder — the short token must not re-trip the hint matcher.
    expect(redacted.match(/<(JWT|API_KEY)_\d{3}>/g)).toHaveLength(1)
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("redacts AWS secret access keys via the underscore-joined hint", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    const { redacted } = redactText(`aws_secret_access_key=${secret}`)
    expect(redacted).toMatch(/<API_KEY_\d{3}>/)
    expect(redacted).not.toContain(secret)
  })

  it("captures dotted/punctuation secrets whole (value stops at whitespace)", () => {
    const dotted = "ab.cd.ef.gh.ij.kl.mn.op.qr.st"
    const { redacted } = redactText(`token: ${dotted} end`)
    expect(redacted).toMatch(/<API_KEY_\d{3}>/)
    expect(redacted).not.toContain(dotted)
    expect(redacted).toContain(" end")
  })

  it("redacts the password in basic-auth URLs, keeping scheme/user/host", () => {
    const original = "clone https://deploy:s3cr3tP4ssword99@github.com/x/y.git"
    const { redacted, map } = redactText(original)
    expect(redacted).toContain("https://deploy:")
    expect(redacted).toContain("@github.com/x/y.git")
    expect(redacted).not.toContain("s3cr3tP4ssword99")
    expect(redacted).toMatch(/<API_KEY_\d{3}>/)
    expect(unredactText(redacted, map)).toBe(original)
  })

  it("redacts ≥2-group compressed IPv6 but never code-style `::`", () => {
    const addr = redactText("peer 2001:db8::1 connected")
    expect(addr.redacted).toContain("<IP_ADDR_001>")
    expect(addr.redacted).not.toContain("2001:db8::1")

    const code = redactText("call Self::add and std::vector<int> here")
    expect(code.redacted).toContain("Self::add")
    expect(code.redacted).toContain("std::vector")
  })

  it("hasNoLeakingPii flags every hardened kind and ignores clean code", () => {
    expect(hasNoLeakingPii("Card 4111 1111 1111 1111")).toBe(false)
    expect(hasNoLeakingPii("Card 4111-1111-1111-1111")).toBe(false)
    expect(hasNoLeakingPii("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(
      false
    )
    expect(
      hasNoLeakingPii(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
      )
    ).toBe(false)
    expect(hasNoLeakingPii("aws_secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(false)
    expect(hasNoLeakingPii("https://u:p4ssword12345678@host.com")).toBe(false)
    expect(hasNoLeakingPii("peer 2001:db8::1")).toBe(false)
    // Clean code that merely uses `::` is not a false positive.
    expect(hasNoLeakingPii("std::vector<int> v; Self::add(1)")).toBe(true)
  })
})

describe("hasNoLeakingPiiDeep", () => {
  it("passes clean primitives and structures", () => {
    expect(hasNoLeakingPiiDeep(null)).toBe(true)
    expect(hasNoLeakingPiiDeep(undefined)).toBe(true)
    expect(hasNoLeakingPiiDeep(42)).toBe(true)
    expect(hasNoLeakingPiiDeep(true)).toBe(true)
    expect(hasNoLeakingPiiDeep(new Date())).toBe(true)
    expect(hasNoLeakingPiiDeep(["clean", "also clean", 1, false])).toBe(true)
    expect(hasNoLeakingPiiDeep({ a: "ok", b: { c: "still ok" } })).toBe(true)
  })

  it("flags PII nested deep inside an object", () => {
    expect(hasNoLeakingPiiDeep({ level1: { level2: { contact: "alice@example.com" } } })).toBe(
      false
    )
  })

  it("flags PII inside an array element", () => {
    expect(hasNoLeakingPiiDeep(["fine", "Server at 8.8.8.8"])).toBe(false)
  })

  it("scans Map keys and values", () => {
    const map = new Map<string, unknown>([["k", "token sk-proj-abc123def456ghi789jkl012"]])
    expect(hasNoLeakingPiiDeep(map)).toBe(false)
    expect(hasNoLeakingPiiDeep(new Map([["clean", "value"]]))).toBe(true)
  })

  it("scans Set members", () => {
    expect(hasNoLeakingPiiDeep(new Set(["clean", "Passport E12345678"]))).toBe(false)
    expect(hasNoLeakingPiiDeep(new Set(["a", "b"]))).toBe(true)
  })

  it("treats a circular object as unsafe", () => {
    const cyclic: Record<string, unknown> = { a: "ok" }
    cyclic.self = cyclic
    expect(hasNoLeakingPiiDeep(cyclic)).toBe(false)
  })
})

describe("translateOffsetsThroughRedaction", () => {
  const { redactText, translateOffsetsThroughRedaction } = jest.requireActual("@cognia/redact")

  function entry(charStart: number, charEnd: number, pageNumber = 1) {
    return { pageNumber, charStart, charEnd }
  }

  it("is the identity when the text contains no PII", () => {
    const original = "plain text with nothing sensitive at all"
    const { redacted, map } = redactText(original)
    expect(redacted).toBe(original)

    const out = translateOffsetsThroughRedaction([entry(0, 10), entry(10, 40)], redacted, map)
    expect(out).toEqual([entry(0, 10), entry(10, 40)])
  })

  it("translates offsets before, across, and after a placeholder exactly", () => {
    const prefix = "Reach out to "
    const email = "alice@example.com"
    const suffix = " for the launch details."
    const original = `${prefix}${email}${suffix}`
    const { redacted, map } = redactText(original)
    expect(redacted.length).not.toBe(original.length)

    const placeholder = Object.keys(map)[0]
    const redStart = redacted.indexOf(placeholder)
    const redEnd = redStart + placeholder.length

    const out = translateOffsetsThroughRedaction(
      [
        entry(0, prefix.length), // entirely before the PII — identity
        entry(prefix.length, prefix.length + email.length), // exactly the PII span
        entry(prefix.length + email.length, original.length), // after the PII — shifted
      ],
      redacted,
      map
    )

    expect(out[0]).toEqual(entry(0, prefix.length))
    expect(out[1].charStart).toBe(redStart)
    expect(out[1].charEnd).toBe(redEnd)
    expect(out[2].charStart).toBe(redEnd)
    expect(out[2].charEnd).toBe(redacted.length)
  })

  it("clamps an offset that falls inside a redacted span to the placeholder bounds", () => {
    const original = "x alice@example.com y"
    const { redacted, map } = redactText(original)
    const placeholder = Object.keys(map)[0]
    const redStart = redacted.indexOf(placeholder)
    const redEnd = redStart + placeholder.length

    // Offset 10 is mid-email in original space — no exact redacted twin.
    const [out] = translateOffsetsThroughRedaction([entry(10, 10)], redacted, map)
    expect(out.charStart).toBeGreaterThanOrEqual(redStart)
    expect(out.charStart).toBeLessThanOrEqual(redEnd)
  })

  it("accumulates shifts across multiple placeholders", () => {
    const original =
      "First alice@example.com then some middle text then bob@example.org at the end tail"
    const { redacted, map } = redactText(original)
    expect(Object.keys(map).length).toBe(2)

    // The trailing " at the end tail" segment after BOTH placeholders.
    const tail = " at the end tail"
    const origTailStart = original.length - tail.length
    const redTailStart = redacted.length - tail.length

    const [out] = translateOffsetsThroughRedaction(
      [entry(origTailStart, original.length)],
      redacted,
      map
    )
    expect(out.charStart).toBe(redTailStart)
    expect(out.charEnd).toBe(redacted.length)
    expect(redacted.slice(out.charStart, out.charEnd)).toBe(tail)
  })

  it("preserves extra entry fields (bboxUnion, pageNumber)", () => {
    const original = "no pii here"
    const { redacted, map } = redactText(original)
    const bboxUnion = { x: 1, y: 2, width: 3, height: 4 }

    const [out] = translateOffsetsThroughRedaction(
      [{ pageNumber: 7, charStart: 0, charEnd: 5, bboxUnion }],
      redacted,
      map
    )
    expect(out.pageNumber).toBe(7)
    expect(out.bboxUnion).toEqual(bboxUnion)
  })

  it("clamps out-of-range offsets to the redacted text bounds", () => {
    const original = "short alice@example.com text"
    const { redacted, map } = redactText(original)

    const [out] = translateOffsetsThroughRedaction([entry(0, original.length + 50)], redacted, map)
    expect(out.charEnd).toBe(redacted.length)
  })
})

describe("placeholder pattern single-source (PII_KINDS)", () => {
  it("PII_KINDS covers every kind the redactor can emit", () => {
    // One representative input per kind — each must tokenize under a kind
    // that PII_KINDS contains, so a new emitter can't ship without joining
    // the canonical list (and thus every derived scanner).
    const samples: Record<string, string> = {
      EMAIL: "mail alice@example.com",
      PHONE: "call 13812345678 now",
      CN_ID: "ID 11010519900101111X",
      BANK_CARD: "Card: 4111111111111111",
      NAME: "Bob said hi", // via nameHints
      IP_ADDR: "server 8.8.8.8",
      API_KEY: "key sk-proj-abcdefghijklmnop123456",
      JWT: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      PEM_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      PASSPORT: "passport E12345678",
      DRIVER_LICENSE: "driver license: 123456789012",
    }
    for (const [kind, text] of Object.entries(samples)) {
      const { map } = redactText(text, kind === "NAME" ? ["Bob"] : [])
      const kinds = Object.values(map).map((r) => r.kind)
      expect(kinds).toContain(kind)
      expect(PII_KINDS).toContain(kind as (typeof PII_KINDS)[number])
    }
    expect(PII_KINDS).toHaveLength(11)
  })

  it("PII_PLACEHOLDER_SOURCE matches every kind including JWT and PEM_KEY", () => {
    const re = new RegExp(PII_PLACEHOLDER_SOURCE)
    for (const kind of PII_KINDS) {
      expect(re.test(`<${kind}_001>`)).toBe(true)
    }
    expect(re.test("<UNKNOWN_001>")).toBe(false)
  })

  it("unredactText round-trips placeholders with 4+ digit counters", () => {
    const map = {
      "<NAME_1234>": { placeholder: "<NAME_1234>", original: "张伟", kind: "NAME" as const },
      "<JWT_1000>": { placeholder: "<JWT_1000>", original: "eyJx.eyJ5.zzz", kind: "JWT" as const },
    }
    const out = unredactText("hi <NAME_1234>, token <JWT_1000>", map)
    expect(out).toBe("hi 张伟, token eyJx.eyJ5.zzz")
  })

  it("does not double-tokenize 4+ digit placeholders on a second pass", () => {
    // The phone / compressed-IPv6 skip-guards must recognise wide counters,
    // otherwise re-redacting already-redacted text mangles the tokens.
    const already = "call <PHONE_1000> or ping <IP_ADDR_1000>"
    const { redacted } = redactText(already)
    expect(redacted).toBe(already)
  })
})
