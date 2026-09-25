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
  getQuestStoreVersion,
  getRemainingBudget,
  handleQuestEvent,
  isClaimInFlight,
  subscribeQuestStore,
  type QuestStoreEffects,
} from "./quest-store"

const NOW = 1_700_000_000_000

type Grant = { grantedXp: number; grantedCoins: number }

function setup(reward: QuestStoreEffects["reward"]) {
  const persist = jest.fn()
  const reportClaimFailure = jest.fn<void, [string, unknown]>()
  const effects: QuestStoreEffects = {
    persist,
    reward,
    getRemainingBudget: () => ({ xp: 100, coins: 100 }),
    reportClaimFailure,
    now: () => NOW,
  }
  configureQuestStore(undefined, effects)
  return { persist, reportClaimFailure }
}

/** A grant the test settles by hand, to observe the store mid-claim. */
function deferredGrant() {
  let resolve: (grant: Grant) => void = () => undefined
  const promise = new Promise<Grant>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
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
    const reward = jest.fn(async (): Promise<Grant> => ({ grantedXp: 4, grantedCoins: 8 }))
    setup(reward)
    const questId = completeFirstQuest()
    expect(getQuestState()?.quests[0].done).toBe(true)

    await expect(claimQuestReward(questId)).resolves.toEqual({ grantedXp: 4, grantedCoins: 8 })
    expect(reward).toHaveBeenCalledTimes(1)
    expect(claimedOf(questId)).toBe(true)
  })

  it("leaves the quest CLAIMABLE when the grant rejects, and reports it", async () => {
    const error = new Error("pet:emit rate limit exceeded")
    const reward = jest.fn(async (): Promise<Grant> => {
      throw error
    })
    const { reportClaimFailure } = setup(reward)
    const questId = completeFirstQuest()

    await expect(claimQuestReward(questId)).rejects.toThrow(/rate limit/)

    // The whole point: a failed grant must not consume the quest.
    expect(claimedOf(questId)).toBe(false)
    expect(getQuestState()?.quests[0].done).toBe(true)
    expect(reportClaimFailure).toHaveBeenCalledWith(questId, error)
    expect(isClaimInFlight(questId)).toBe(false)
  })

  it("can be retried successfully after a failed grant", async () => {
    const reward = jest
      .fn<Promise<Grant>, [{ xp: number; coins: number }]>()
      .mockRejectedValueOnce(new Error("pet:interact denied"))
      .mockResolvedValueOnce({ grantedXp: 4, grantedCoins: 8 })
    setup(reward)
    const questId = completeFirstQuest()

    await expect(claimQuestReward(questId)).rejects.toThrow(/denied/)
    await expect(claimQuestReward(questId)).resolves.toEqual({ grantedXp: 4, grantedCoins: 8 })
    expect(claimedOf(questId)).toBe(true)
  })

  it("returns null without granting for an unknown or unfinished quest", async () => {
    const reward = jest.fn(async (): Promise<Grant> => ({ grantedXp: 0, grantedCoins: 0 }))
    setup(reward)
    await expect(claimQuestReward("does-not-exist")).resolves.toBeNull()
    // First quest exists but is not done yet.
    const pending = getQuestState()?.quests[0].id as string
    await expect(claimQuestReward(pending)).resolves.toBeNull()
    expect(reward).not.toHaveBeenCalled()
  })

  it("notifies subscribers when a claim lands", async () => {
    const reward = jest.fn(async (): Promise<Grant> => ({ grantedXp: 4, grantedCoins: 8 }))
    setup(reward)
    const questId = completeFirstQuest()
    const listener = jest.fn()
    const unsubscribe = subscribeQuestStore(listener)
    await claimQuestReward(questId)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it("reports zero budget once the store is disposed", () => {
    setup(jest.fn<Promise<Grant>, [{ xp: number; coins: number }]>())
    expect(getRemainingBudget()).toEqual({ xp: 100, coins: 100 })
    disposeQuestStore()
    expect(getRemainingBudget()).toEqual({ xp: 0, coins: 0 })
    expect(getQuestState()).toBeNull()
  })

  it("grants a quest once when it is claimed twice before the first grant lands", async () => {
    const grant = deferredGrant()
    const reward = jest.fn((_reward: { xp: number; coins: number }) => grant.promise)
    setup(reward)
    const questId = completeFirstQuest()

    const first = claimQuestReward(questId)
    const second = claimQuestReward(questId)
    expect(isClaimInFlight(questId)).toBe(true)
    await expect(second).resolves.toBeNull()

    grant.resolve({ grantedXp: 4, grantedCoins: 8 })
    await expect(first).resolves.toEqual({ grantedXp: 4, grantedCoins: 8 })
    expect(reward).toHaveBeenCalledTimes(1)
    expect(claimedOf(questId)).toBe(true)
    expect(isClaimInFlight(questId)).toBe(false)
  })

  it("keeps progress made on other quests while a grant was awaited", async () => {
    const grant = deferredGrant()
    setup(jest.fn((_reward: { xp: number; coins: number }) => grant.promise))
    const questId = completeFirstQuest()
    const other = (getQuestState() as QuestState).quests[1]
    const otherDef = questDef(other.id)!

    const claim = claimQuestReward(questId)
    // A pet event lands mid-claim and advances a different quest.
    handleQuestEvent(otherDef.target)
    const progressed = getQuestState()?.quests.find((q) => q.id === other.id)?.progress
    expect(progressed).toBeGreaterThan(0)

    grant.resolve({ grantedXp: 4, grantedCoins: 8 })
    await claim

    expect(claimedOf(questId)).toBe(true)
    // Writing back the pre-await snapshot would have reset this to 0.
    expect(getQuestState()?.quests.find((q) => q.id === other.id)?.progress).toBe(progressed)
  })

  it("publishes a new snapshot when a claim starts and when it settles", async () => {
    const grant = deferredGrant()
    setup(jest.fn((_reward: { xp: number; coins: number }) => grant.promise))
    const questId = completeFirstQuest()
    const before = getQuestStoreVersion()

    const claim = claimQuestReward(questId)
    const started = getQuestStoreVersion()
    expect(started).toBeGreaterThan(before)

    grant.resolve({ grantedXp: 4, grantedCoins: 8 })
    await claim
    expect(getQuestStoreVersion()).toBeGreaterThan(started)
  })
})
