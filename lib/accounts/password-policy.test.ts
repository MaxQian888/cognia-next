import {
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordMeetsPolicy,
  meetsPasswordPolicy,
  scorePasswordStrength,
} from "./password-policy"

describe("password policy", () => {
  it("treats the minimum length as the hard gate", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8)
    expect(meetsPasswordPolicy("a".repeat(7))).toBe(false)
    expect(meetsPasswordPolicy("a".repeat(8))).toBe(true)
  })

  it("throws a typed error for too-short passwords", () => {
    expect(() => assertPasswordMeetsPolicy("short")).toThrow(PasswordPolicyError)
    expect(() => assertPasswordMeetsPolicy("short")).toThrow(/at least 8/)
    expect(() => assertPasswordMeetsPolicy("longenough")).not.toThrow()
    expect(new PasswordPolicyError().code).toBe("password-too-short")
  })

  it("scores below-minimum passwords as tooShort", () => {
    expect(scorePasswordStrength("")).toEqual({ score: 0, label: "tooShort" })
    expect(scorePasswordStrength("abc")).toEqual({ score: 0, label: "tooShort" })
  })

  it("rates length tiers and character diversity from weak to strong", () => {
    // 8 chars, single class → weak
    expect(scorePasswordStrength("aaaaaaaa")).toEqual({ score: 1, label: "weak" })
    // 12 chars, single class → fair
    expect(scorePasswordStrength("aaaaaaaaaaaa")).toEqual({ score: 2, label: "fair" })
    // 8 chars but 3 classes → fair (diversity bonus)
    expect(scorePasswordStrength("Abc12345")).toEqual({ score: 2, label: "fair" })
    // 12 chars + 3 classes → good
    expect(scorePasswordStrength("Abcdef123456")).toEqual({ score: 3, label: "good" })
    // 16 chars + 4 classes → strong
    expect(scorePasswordStrength("Abcdef123456!@#$")).toEqual({ score: 4, label: "strong" })
  })
})
