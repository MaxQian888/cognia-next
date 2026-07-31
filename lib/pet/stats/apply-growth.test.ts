import { ZERO_STAT_PROGRESS, type PetStatProgress } from "@/types/pet"
import { MAX_STAT_PROGRESS, applyStatGrowth, statsGrewKeys } from "./apply-growth"

const delta = (d: Partial<PetStatProgress>): PetStatProgress => ({ ...ZERO_STAT_PROGRESS, ...d })

describe("applyStatGrowth", () => {
  it("starts from zero when no progress exists yet", () => {
    expect(applyStatGrowth(undefined, delta({ debugging: 2 }))).toEqual(delta({ debugging: 2 }))
  })

  it("accumulates onto existing progress", () => {
    const cur = delta({ debugging: 5, patience: 1 })
    expect(applyStatGrowth(cur, delta({ debugging: 3 }))).toEqual(
      delta({ debugging: 8, patience: 1 })
    )
  })

  it("caps each key at MAX_STAT_PROGRESS", () => {
    const cur = delta({ chaos: MAX_STAT_PROGRESS - 1 })
    expect(applyStatGrowth(cur, delta({ chaos: 10 })).chaos).toBe(MAX_STAT_PROGRESS)
  })

  it("normalizes a legacy partial progress before adding", () => {
    const cur = { debugging: 4 } as unknown as PetStatProgress
    const out = applyStatGrowth(cur, delta({ patience: 2 }))
    expect(out).toEqual(delta({ debugging: 4, patience: 2 }))
  })
})

describe("statsGrewKeys", () => {
  it("reports only the keys that increased", () => {
    const before = delta({ debugging: 5, wisdom: 3 })
    const after = delta({ debugging: 6, wisdom: 3, chaos: 1 })
    expect(statsGrewKeys(before, after).sort()).toEqual(["chaos", "debugging"])
  })

  it("returns empty when nothing changed", () => {
    const same = delta({ snark: 2 })
    expect(statsGrewKeys(same, same)).toEqual([])
  })
})
