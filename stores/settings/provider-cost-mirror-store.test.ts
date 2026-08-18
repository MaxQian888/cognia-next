// Coverage for the in-memory daily-spend mirror — hydration, accumulation,
// lazy day rollover, invalid-input guards, and the synchronous read.

import { useProviderCostMirrorStore } from "./provider-cost-mirror-store"
import { localDayString } from "@/lib/db/provider-cost-daily"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()
const TOMORROW_NOON = NOON + 86_400_000

beforeEach(() => {
  useProviderCostMirrorStore.getState().reset()
})

describe("hydrate", () => {
  it("replaces totals and day wholesale", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 1.5, anthropic: 2 }, "2026-06-05")
    expect(useProviderCostMirrorStore.getState().day).toBe("2026-06-05")
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(1.5)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("anthropic")).toBe(2)
  })
})

describe("addCost", () => {
  it("accumulates per provider within the same day", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({}, localDayString(NOON))
    s.addCost("openai", 0.5, NOON)
    s.addCost("openai", 0.25, NOON + 1000)
    s.addCost("groq", 0.1, NOON + 2000)
    const state = useProviderCostMirrorStore.getState()
    expect(state.getTodaySpend("openai")).toBeCloseTo(0.75)
    expect(state.getTodaySpend("groq")).toBeCloseTo(0.1)
  })

  it("resets totals when the local day rolls over", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 5 }, localDayString(NOON))
    s.addCost("openai", 1, TOMORROW_NOON)
    const state = useProviderCostMirrorStore.getState()
    expect(state.day).toBe(localDayString(TOMORROW_NOON))
    // Yesterday's 5 USD is gone; only the new day's 1 USD remains.
    expect(state.getTodaySpend("openai")).toBe(1)
  })

  it("ignores invalid input", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({}, localDayString(NOON))
    s.addCost("", 1, NOON)
    s.addCost("openai", 0, NOON)
    s.addCost("openai", -1, NOON)
    s.addCost("openai", Number.NaN, NOON)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
  })
})

describe("getTodaySpend", () => {
  it("returns 0 for unknown providers", () => {
    expect(useProviderCostMirrorStore.getState().getTodaySpend("nope")).toBe(0)
  })
})

describe("reset", () => {
  it("clears day and totals", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 3 }, "2026-06-05")
    s.reset()
    const state = useProviderCostMirrorStore.getState()
    expect(state.day).toBe("")
    expect(state.getTodaySpend("openai")).toBe(0)
  })
})

describe("rollbackCost", () => {
  it("reverses an optimistic add whose durable write never landed", () => {
    const s = useProviderCostMirrorStore.getState()
    s.addCost("openai", 0.5, NOON)
    s.addCost("openai", 0.25, NOON)
    s.rollbackCost("openai", 0.25, NOON)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(0.5, 6)
  })

  it("clamps at 0 so an over-rollback cannot make the mirror under-report", () => {
    const s = useProviderCostMirrorStore.getState()
    s.addCost("openai", 0.1, NOON)
    s.rollbackCost("openai", 99, NOON)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
  })

  it("ignores a rollback for a day the mirror has already rolled past", () => {
    const s = useProviderCostMirrorStore.getState()
    s.addCost("openai", 1, NOON)
    s.addCost("openai", 2, TOMORROW_NOON) // rollover resets to a fresh bucket
    s.rollbackCost("openai", 1, NOON)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(2)
  })

  it("ignores unknown providers and invalid amounts", () => {
    const s = useProviderCostMirrorStore.getState()
    s.addCost("openai", 1, NOON)
    s.rollbackCost("", 1, NOON)
    s.rollbackCost("openai", 0, NOON)
    s.rollbackCost("openai", Number.NaN, NOON)
    s.rollbackCost("never-seen", 1, NOON)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(1)
  })
})

describe("reconcileProvider", () => {
  it("snaps a provider to the committed durable total", () => {
    const day = localDayString(NOON)
    const s = useProviderCostMirrorStore.getState()
    s.addCost("openai", 0.5, NOON)
    // Durable truth disagrees (an earlier write was lost) — Dexie wins.
    s.reconcileProvider("openai", day, 1.75)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(1.75, 6)
  })

  it("adopts the committed day when the mirror has not hydrated yet", () => {
    const day = localDayString(NOON)
    useProviderCostMirrorStore.getState().reconcileProvider("openai", day, 2)
    const state = useProviderCostMirrorStore.getState()
    expect(state.day).toBe(day)
    expect(state.getTodaySpend("openai")).toBe(2)
  })

  it("ignores a total committed against a different day", () => {
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 3 }, localDayString(NOON))
    // A turn that committed just before local midnight must not resurrect
    // yesterday's spend into today's bucket.
    s.reconcileProvider("openai", localDayString(TOMORROW_NOON), 99)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(3)
  })

  it("leaves other providers untouched", () => {
    const day = localDayString(NOON)
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 1, anthropic: 2 }, day)
    s.reconcileProvider("openai", day, 5)
    const state = useProviderCostMirrorStore.getState()
    expect(state.getTodaySpend("openai")).toBe(5)
    expect(state.getTodaySpend("anthropic")).toBe(2)
  })

  it("ignores invalid input", () => {
    const day = localDayString(NOON)
    const s = useProviderCostMirrorStore.getState()
    s.hydrate({ openai: 1 }, day)
    s.reconcileProvider("", day, 5)
    s.reconcileProvider("openai", "", 5)
    s.reconcileProvider("openai", day, -1)
    s.reconcileProvider("openai", day, Number.NaN)
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(1)
  })
})
