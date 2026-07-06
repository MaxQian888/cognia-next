import {
  advanceQuests,
  claimQuest,
  ensureDay,
  localDayKey,
  QUEST_POOL,
  questDef,
  rollDailyQuests,
} from "./quest-engine"

const DAY = "2026-07-02"

describe("QUEST_POOL invariants", () => {
  it("has unique ids resolvable via questDef", () => {
    const ids = QUEST_POOL.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(questDef("feed3")?.target).toBe("fed")
    expect(questDef("nope")).toBeUndefined()
  })

  it("keeps any 3-quest day within the per-plugin daily budgets (50 XP / 100 coins)", () => {
    const sorted = [...QUEST_POOL].sort((a, b) => b.rewardXp - a.rewardXp)
    const worstXp = sorted.slice(0, 3).reduce((sum, q) => sum + q.rewardXp, 0)
    const worstCoins = [...QUEST_POOL]
      .sort((a, b) => b.rewardCoins - a.rewardCoins)
      .slice(0, 3)
      .reduce((sum, q) => sum + q.rewardCoins, 0)
    expect(worstXp).toBeLessThanOrEqual(50)
    expect(worstCoins).toBeLessThanOrEqual(100)
  })
})

describe("rollDailyQuests", () => {
  it("is deterministic per day and picks 3 distinct quests", () => {
    const a = rollDailyQuests(DAY)
    const b = rollDailyQuests(DAY)
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id))
    expect(new Set(a.map((q) => q.id)).size).toBe(3)
  })

  it("usually rolls different sets on different days", () => {
    const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]
    const sets = new Set(
      days.map((d) =>
        rollDailyQuests(d)
          .map((q) => q.id)
          .join(",")
      )
    )
    expect(sets.size).toBeGreaterThan(1)
  })
})

describe("ensureDay", () => {
  it("keeps same-day state and re-rolls on rollover", () => {
    const state = ensureDay(undefined, DAY)
    expect(state.day).toBe(DAY)
    expect(state.quests).toHaveLength(3)
    expect(ensureDay(state, DAY)).toBe(state)
    const next = ensureDay(state, "2026-07-03")
    expect(next.day).toBe("2026-07-03")
    expect(next.quests.every((q) => q.progress === 0 && !q.claimed)).toBe(true)
  })
})

describe("advanceQuests / claimQuest", () => {
  function stateWith(questId: string) {
    // Build a state that definitely contains the quest under test.
    return {
      day: DAY,
      quests: [{ id: questId, progress: 0, done: false, claimed: false }],
    }
  }

  it("advances matching quests to done and ignores non-matching kinds", () => {
    let state = stateWith("feed3")
    state = advanceQuests(state, "played")
    expect(state.quests[0].progress).toBe(0)
    state = advanceQuests(state, "fed")
    state = advanceQuests(state, "fed")
    expect(state.quests[0]).toMatchObject({ progress: 2, done: false })
    state = advanceQuests(state, "fed")
    expect(state.quests[0]).toMatchObject({ progress: 3, done: true })
    // Done quests stop accumulating.
    const after = advanceQuests(state, "fed")
    expect(after.quests[0].progress).toBe(3)
  })

  it("claims exactly once and only when done", () => {
    let state = stateWith("sleep1")
    expect(claimQuest(state, "sleep1").reward).toBeNull()
    state = advanceQuests(state, "slept")
    const first = claimQuest(state, "sleep1")
    expect(first.reward).toEqual({ xp: 3, coins: 5 })
    const second = claimQuest(first.state, "sleep1")
    expect(second.reward).toBeNull()
    expect(claimQuest(state, "unknown").reward).toBeNull()
  })
})

describe("localDayKey", () => {
  it("formats the local calendar day", () => {
    expect(localDayKey(new Date("2026-07-02T12:00:00").getTime())).toBe("2026-07-02")
  })
})
