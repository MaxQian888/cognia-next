/**
 * Runtime bridge between the plugin's activate() wiring and the quests tab.
 * A tiny module-level store (useSyncExternalStore-compatible) holding the
 * QuestState plus injected host effects: persist (ctx.storage), reward
 * (ctx.pet.emitEvent) and the remaining-budget probe. Pure state math lives
 * in `quest-engine.ts`; this module only sequences it.
 */

import { advanceQuests, claimQuest, ensureDay, localDayKey, type QuestState } from "./quest-engine"

export interface QuestStoreEffects {
  persist: (state: QuestState) => void | Promise<void>
  /** Grant a (budget-clamped) reward; resolves what was actually granted. */
  reward: (reward: { xp: number; coins: number }) => Promise<{
    grantedXp: number
    grantedCoins: number
  }>
  getRemainingBudget: () => { xp: number; coins: number }
  now?: () => number
}

let state: QuestState | null = null
let effects: QuestStoreEffects | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function setState(next: QuestState): void {
  if (next === state) return
  state = next
  void effects?.persist(next)
  notify()
}

/** Wire the host effects + hydrate. Called from activate(). */
export function configureQuestStore(
  initial: QuestState | undefined,
  nextEffects: QuestStoreEffects
): void {
  effects = nextEffects
  state = ensureDay(initial, localDayKey((nextEffects.now ?? Date.now)()))
  void nextEffects.persist(state)
  notify()
}

/** Unwire on deactivate. */
export function disposeQuestStore(): void {
  effects = null
  state = null
  notify()
}

export function subscribeQuestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getQuestState(): QuestState | null {
  return state
}

export function getRemainingBudget(): { xp: number; coins: number } {
  return effects?.getRemainingBudget() ?? { xp: 0, coins: 0 }
}

/** Advance quests for a pet/goal event kind (rolls the day lazily first). */
export function handleQuestEvent(eventKind: string): void {
  if (!state || !effects) return
  const today = ensureDay(state, localDayKey((effects.now ?? Date.now)()))
  const next = advanceQuests(today, eventKind)
  if (next !== state) setState(next)
}

/** Claim a completed quest; grants the reward through the host effect. */
export async function claimQuestReward(
  questId: string
): Promise<{ grantedXp: number; grantedCoins: number } | null> {
  if (!state || !effects) return null
  const { state: next, reward } = claimQuest(state, questId)
  if (!reward) return null
  // Grant FIRST, mark claimed only on success. `effects.reward` routes to
  // `ctx.pet.emitEvent`, which throws on the plugin rate limiter and on a
  // denied `pet:interact` grant. Marking the quest claimed before awaiting it
  // burnt the quest permanently for zero reward whenever that happened — and
  // the UI calls this as `void claimQuestReward(...)`, so the rejection was
  // unhandled and the user saw nothing at all.
  const granted = await effects.reward(reward)
  setState(next)
  return granted
}
