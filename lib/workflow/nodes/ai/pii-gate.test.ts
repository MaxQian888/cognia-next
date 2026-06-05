import { applyPiiGate, PiiBlockedError } from "./pii-gate"

const PII_TEXT = "Contact me at alice@example.com please"
const CLEAN_TEXT = "Summarize the quarterly report"

describe("applyPiiGate", () => {
  describe("off / undefined", () => {
    it("passes text through untouched", () => {
      const r = applyPiiGate("off", { system: PII_TEXT, user: PII_TEXT })
      expect(r).toEqual({ system: PII_TEXT, user: PII_TEXT, redacted: false })
    })

    it("treats undefined mode as off", () => {
      const r = applyPiiGate(undefined, { user: PII_TEXT })
      expect(r.user).toBe(PII_TEXT)
      expect(r.redacted).toBe(false)
    })
  })

  describe("block", () => {
    it("throws a non-retryable PiiBlockedError when the user prompt leaks", () => {
      expect(() => applyPiiGate("block", { user: PII_TEXT })).toThrow(PiiBlockedError)
      try {
        applyPiiGate("block", { user: PII_TEXT })
      } catch (err) {
        expect((err as PiiBlockedError).retryable).toBe(false)
      }
    })

    it("throws when only the system prompt leaks", () => {
      expect(() => applyPiiGate("block", { system: PII_TEXT, user: CLEAN_TEXT })).toThrow(
        PiiBlockedError
      )
    })

    it("passes clean prompts through", () => {
      const r = applyPiiGate("block", { system: CLEAN_TEXT, user: CLEAN_TEXT })
      expect(r).toEqual({ system: CLEAN_TEXT, user: CLEAN_TEXT, redacted: false })
    })

    it("passes when system is absent and user is clean", () => {
      const r = applyPiiGate("block", { user: CLEAN_TEXT })
      expect(r.user).toBe(CLEAN_TEXT)
      expect(r.system).toBeUndefined()
    })
  })

  describe("redact", () => {
    it("replaces PII in the user prompt and flags it", () => {
      const r = applyPiiGate("redact", { user: PII_TEXT })
      expect(r.user).not.toContain("alice@example.com")
      expect(r.redacted).toBe(true)
    })

    it("redacts the system prompt independently", () => {
      const r = applyPiiGate("redact", { system: PII_TEXT, user: CLEAN_TEXT })
      expect(r.system).not.toContain("alice@example.com")
      expect(r.user).toBe(CLEAN_TEXT)
      expect(r.redacted).toBe(true)
    })

    it("reports redacted=false when nothing matched", () => {
      const r = applyPiiGate("redact", { system: CLEAN_TEXT, user: CLEAN_TEXT })
      expect(r.redacted).toBe(false)
      expect(r.user).toBe(CLEAN_TEXT)
      expect(r.system).toBe(CLEAN_TEXT)
    })

    it("leaves an absent system prompt absent", () => {
      const r = applyPiiGate("redact", { user: CLEAN_TEXT })
      expect(r.system).toBeUndefined()
    })
  })
})
