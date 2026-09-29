import { canRecheckVideoJob, isSettledVideoJob, newVideoJobId } from "./types"

describe("video job types", () => {
  it("knows which statuses are settled", () => {
    expect(isSettledVideoJob({ status: "generating" })).toBe(false)
    expect(isSettledVideoJob({ status: "downloading" })).toBe(false)
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isSettledVideoJob({ status })).toBe(true)
    }
  })

  it("only offers a recheck where the remote job may still be fine", () => {
    expect(canRecheckVideoJob({ status: "timed_out" })).toBe(true)
    expect(
      canRecheckVideoJob({
        status: "failed",
        error: { code: "credential_changed", message: "", recheckable: true },
      })
    ).toBe(true)
    expect(
      canRecheckVideoJob({
        status: "failed",
        error: { code: "generation_failed", message: "", recheckable: false },
      })
    ).toBe(false)
    expect(canRecheckVideoJob({ status: "cancelled" })).toBe(false)
    expect(canRecheckVideoJob({ status: "succeeded" })).toBe(false)
  })

  it("mints sortable, prefixed ids", () => {
    expect(newVideoJobId(36)).toMatch(/^vjob_10_[a-z0-9]{1,6}$/)
  })
})
