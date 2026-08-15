import { DEFAULT_RUN_STATUS_BAR } from "./run-bar-defaults"
import { DEFAULT_RUN_STATUS_BAR as REEXPORTED } from "./run-bar-metrics"
import { DEFAULTS } from "@/lib/db/settings"

describe("run-bar-defaults", () => {
  it("is the single default source re-exported by run-bar-metrics", () => {
    expect(REEXPORTED).toBe(DEFAULT_RUN_STATUS_BAR)
  })

  it("is spread into canonical settings DEFAULTS (ADR-0127)", () => {
    expect(DEFAULTS.runStatusBar).toEqual(DEFAULT_RUN_STATUS_BAR)
    // A copy, not the same reference — mutating DEFAULTS must never leak.
    expect(DEFAULTS.runStatusBar).not.toBe(DEFAULT_RUN_STATUS_BAR)
  })

  it("keeps every metric flag explicit", () => {
    expect(Object.keys(DEFAULT_RUN_STATUS_BAR).sort()).toEqual([
      "showContextPct",
      "showCost",
      "showElapsed",
      "showOutputTokens",
      "showSpeed",
      "showTools",
    ])
  })
})
