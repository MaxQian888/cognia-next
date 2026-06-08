import { QUIESCE_MS, QUIESCE_MS_LOW_POWER, quiescenceDelay, shouldQuiesce } from "./idle-quiescence"

describe("quiescenceDelay", () => {
  it("is shorter under low power", () => {
    expect(quiescenceDelay(false)).toBe(QUIESCE_MS)
    expect(quiescenceDelay(true)).toBe(QUIESCE_MS_LOW_POWER)
    expect(QUIESCE_MS_LOW_POWER).toBeLessThan(QUIESCE_MS)
  })
})

describe("shouldQuiesce", () => {
  it("quiesces a long-idle pet with no one-shot", () => {
    expect(shouldQuiesce("idle", null, QUIESCE_MS + 1, { lowPower: false })).toBe(true)
  })

  it("does not quiesce before the delay", () => {
    expect(shouldQuiesce("idle", null, QUIESCE_MS - 1, { lowPower: false })).toBe(false)
  })

  it("never quiesces a non-idle state", () => {
    expect(shouldQuiesce("thinking", null, 999_999, { lowPower: false })).toBe(false)
    expect(shouldQuiesce("unwell", null, 999_999, { lowPower: false })).toBe(false)
  })

  it("never quiesces while a one-shot is playing", () => {
    expect(shouldQuiesce("idle", "wave", 999_999, { lowPower: false })).toBe(false)
  })

  it("respects the low-power delay", () => {
    expect(shouldQuiesce("idle", null, QUIESCE_MS_LOW_POWER + 1, { lowPower: true })).toBe(true)
    expect(shouldQuiesce("idle", null, QUIESCE_MS_LOW_POWER + 1, { lowPower: false })).toBe(false)
  })
})
