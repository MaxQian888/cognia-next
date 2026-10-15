import { hasNoLeakingPii } from "@cognia/redact"

import { gateTextForModel } from "./pii-gate"

describe("gateTextForModel", () => {
  it("passes clean text through untouched", () => {
    expect(gateTextForModel("const total = a + b")).toEqual({
      ok: true,
      text: "const total = a + b",
      redacted: false,
    })
  })

  it("redacts an email and re-checks the result", () => {
    const gated = gateTextForModel("+const owner = 'alice.smith@example.com'")
    expect(gated.ok).toBe(true)
    if (!gated.ok) return
    expect(gated.redacted).toBe(true)
    expect(gated.text).not.toContain("alice.smith@example.com")
    expect(hasNoLeakingPii(gated.text)).toBe(true)
  })

  it("catches a secret split by an escape sequence that raw redaction would miss", () => {
    const split = "+const key = 'sk-proj-abcd\u001b[0mEFGH1234567890abcdefXYZ'"
    const gated = gateTextForModel(split)
    if (gated.ok) {
      expect(gated.text).not.toContain("EFGH1234567890abcdefXYZ")
      expect(hasNoLeakingPii(gated.text)).toBe(true)
    } else {
      expect(gated).toEqual({ ok: false })
    }
  })
})
