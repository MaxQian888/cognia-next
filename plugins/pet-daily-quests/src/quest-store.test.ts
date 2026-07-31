/**
 * `quest-store.ts` had no co-located test, which is how the claim path shipped
 * marking a quest consumed BEFORE awaiting the reward grant. `effects.reward`
 * routes to `ctx.pet.emitEvent`, which throws on the plugin rate limiter and on
 * a denied `pet:interact` grant — so a rejected grant burnt the quest for zero
 * reward, and the tab's `void claimQuestReward(...)` swallowed the rejection.
 */

import { questDef, type QuestState } from "./quest-engine"
import {
  claimQuestReward,
  configureQuestStore,
  disposeQuestStore,
  getQuestState,
  getRemainingBudget,
  handleQuestEvent,
  subscribeQuestStore,
} from "./quest-store"

const NOW = 1_700_000_000_000

function setup(reward: jest.Mock) {
  const persist = jest.fn()
  configureQuestStore(undefined, {
    persist,
    reward: reward as never,
    getRemainingBudget: () => ({ xp: 100, coins: 100 }),
    now: () => NOW,
  })
  return { persist }
}

/** Drive the first rolled quest to `done` so it becomes claimable. */
function completeFirstQuest(): string {
  const state = getQuestState() as QuestState
  const quest = state.quests[0]
  const def = questDef(quest.id)
  if (!def) throw new Error(`no def for ${quest.id}`)
  for (let i = 0; i < def.count; i++) handleQuestEvent(def.target)
  return quest.id
}

const claimedOf = (id: string) => getQuestState()?.quests.find((q) => q.id === id)?.claimed

afterEach(() => disposeQuestStore())

describe("claimQuestReward", () => {
  it("marks the quest claimed after a successful grant", async () => {
    const reward = jest.fn(async () => ({ grantedXp: 4, grantedCoins: 8 }))
    setup(reward)
    const questId = completeFirstQuest()
    expect(getQuestState()?.quests[0].done).toBe(true)

    await expect(claimQuestReward(questId)).resolves.toEqual({ grantedXp: 4, grantedCoins: 8 })
    expect(reward).toHaveBeenCalledTimes(1)
    expect(claimedOf(questId)).toBe(true)
  })

  it("leaves the quest CLAIMABLE when the grant rejects", async () => {
    const reward = jest.fn(async () => {
      throw new Error("pet:emit rate limit exceeded")
    })
    setup(reward)
    const questId = completeFirstQuest()

    await expect(claimQuestReward(questId)).rejects.toThrow(/rate limit/)

    // The whole point: a failed grant must not consume the quest.
    expect(claimedOf(questId)).toBe(false)
    expect(getQuestState()?.quests[0].done).toBe(true)
  })

  it("can be retried successfully after a failed grant", async () => {
    const reward = jest
      .fn()
      .mockRejectedValueOnce(new Error("pet:interact denied"))
      .mockResolvedValueOnce({ grantedXp: 4, grantedCoins: 8 })
    setup(reward)
    const questId = completeFirstQuest()

    await expect(claimQuestReward(questId)).rejects.toThrow(/denied/)
    await expect(claimQuestReward(questId)).resolves.toEqual({ grantedXp: 4, grantedCoins: 8 })
    expect(claimedOf(questId)).toBe(true)
  })

  it("returns null without granting for an unknown or unfinished quest", async () => {
    const reward = jest.fn(async () => ({ grantedXp: 0, grantedCoins: 0 }))
    setup(reward)
    await expect(claimQuestReward("does-not-exist")).resolves.toBeNull()
    // First quest exists but is not done yet.
    const pending = getQuestState()?.quests[0].id as string
    await expect(claimQuestReward(pending)).resolves.toBeNull()
    expect(reward).not.toHaveBeenCalled()
  })

  it("notifies subscribers when a claim lands", async () => {
    const reward = jest.fn(async () => ({ grantedXp: 4, grantedCoins: 8 }))
    setup(reward)
    const questId = completeFirstQuest()
    const listener = jest.fn()
    const unsubscribe = subscribeQuestStore(listener)
    await claimQuestReward(questId)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it("reports zero budget once the store is disposed", () => {
    setup(jest.fn())
    expect(getRemainingBudget()).toEqual({ xp: 100, coins: 100 })
    disposeQuestStore()
    expect(getRemainingBudget()).toEqual({ xp: 0, coins: 0 })
    expect(getQuestState()).toBeNull()
  })
})
