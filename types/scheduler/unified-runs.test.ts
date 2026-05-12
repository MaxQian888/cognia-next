import { toRunStatusPill, type UnifiedRunStatus } from "./unified-runs"

describe("toRunStatusPill", () => {
  it("passes through every status that the workflow pill already understands", () => {
    const passthrough: UnifiedRunStatus[] = ["running", "succeeded", "failed", "cancelled"]
    for (const status of passthrough) {
      expect(toRunStatusPill(status)).toBe(status)
    }
  })

  it("collapses 'skipped' to 'cancelled' (no skip glyph in RunStatusPill)", () => {
    expect(toRunStatusPill("skipped")).toBe("cancelled")
  })
})
