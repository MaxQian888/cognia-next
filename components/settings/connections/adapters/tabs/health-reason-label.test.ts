import { healthReasonLabel, KNOWN_HEALTH_REASONS } from "./health-reason-label"

describe("healthReasonLabel", () => {
  const t = (key: string) => `t:${key}`

  it("returns undefined for an undefined reason", () => {
    expect(healthReasonLabel(t, undefined)).toBeUndefined()
  })

  it("localizes every known code under the reason.* namespace", () => {
    for (const code of KNOWN_HEALTH_REASONS) {
      expect(healthReasonLabel(t, code)).toBe(`t:reason.${code}`)
    }
  })

  it("passes an unknown reason through unchanged (raw transport error)", () => {
    expect(healthReasonLabel(t, "socket hang up")).toBe("socket hang up")
  })
})
