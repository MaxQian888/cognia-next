import {
  CONSENT_GRANT_DURATIONS_MS,
  DEFAULT_CONSENT_GRANT_DURATION_MS,
  MAX_CONSENT_GRANT_DURATION_MS,
  grantDurationMinutes,
} from "./consent-durations"

describe("consent grant durations", () => {
  it("offers windows in ascending order", () => {
    const sorted = [...CONSENT_GRANT_DURATIONS_MS].sort((a, b) => a - b)
    expect([...CONSENT_GRANT_DURATIONS_MS]).toEqual(sorted)
  })

  it("pre-selects a window that is actually on the menu", () => {
    expect(CONSENT_GRANT_DURATIONS_MS).toContain(DEFAULT_CONSENT_GRANT_DURATION_MS)
  })

  it("never offers a window the host would clamp", () => {
    // The Rust broker silently caps at MAX_GRANT_DURATION_MS. Offering more
    // would tell the operator they bought an hour and quietly give them less.
    for (const ms of CONSENT_GRANT_DURATIONS_MS) {
      expect(ms).toBeLessThanOrEqual(MAX_CONSENT_GRANT_DURATION_MS)
    }
  })

  it("labels each window in whole minutes", () => {
    expect(CONSENT_GRANT_DURATIONS_MS.map(grantDurationMinutes)).toEqual([15, 30, 60])
  })
})
