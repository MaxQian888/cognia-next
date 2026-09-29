import { isSettledVideoJob, newVideoJobId } from "./types"

describe("video job types", () => {
  it("knows which statuses are settled", () => {
    expect(isSettledVideoJob({ status: "generating" })).toBe(false)
    expect(isSettledVideoJob({ status: "downloading" })).toBe(false)
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isSettledVideoJob({ status })).toBe(true)
    }
  })

  it("mints sortable, prefixed ids", () => {
    expect(newVideoJobId(36)).toMatch(/^vjob_10_[a-z0-9]{1,6}$/)
  })
})
