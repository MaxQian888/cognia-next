/**
 * Runtime bridge between the plugin's activate() wiring and the quests tab.
 * A tiny module-level store (useSyncExternalStore-compatible) holding the
 * QuestState plus injected host effects: persist (ctx.storage), reward
 * (ctx.pet.emitEvent), the remaining-budget probe and the claim-failure
 * report. Pure state math lives in `quest-engine.ts`; this module only
 * sequences it.
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
  /**
   * Tell the user a grant failed (rate limit, denied `pet:interact`). The
   * quest stays claimable, so the message should invite a retry.
   */
  reportClaimFailure: (questId: string, error: unknown) => void
  now?: () => number
}

let state: QuestState | null = null
let effects: QuestStoreEffects | null = null
/**
 * Quest ids whose grant is awaiting the host right now, each with the token of
 * the claim that owns the slot (so a claim that outlives a reconfigure cannot
 * clear a newer claim's flag).
 */
const claimsInFlight = new Map<string, object>()
const listeners = new Set<() => void>()
/** Bumped on every change, including in-flight flags that leave `state` as is. */
let version = 0

function notify(): void {
  version += 1
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
  claimsInFlight.clear()
  state = ensureDay(initial, localDayKey((nextEffects.now ?? Date.now)()))
  void nextEffects.persist(state)
  notify()
}

/** Unwire on deactivate. */
export function disposeQuestStore(): void {
  effects = null
  state = null
  claimsInFlight.clear()
  notify()
}

export function subscribeQuestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getQuestState(): QuestState | null {
  return state
}

/**
 * `useSyncExternalStore` snapshot for views that render in-flight claims too:
 * a claim starting or settling changes no quest, so `getQuestState()` alone
 * would not re-render them.
 */
export function getQuestStoreVersion(): number {
  return version
}

export function getRemainingBudget(): { xp: number; coins: number } {
  return effects?.getRemainingBudget() ?? { xp: 0, coins: 0 }
}

/** Whether a claim for `questId` is waiting on the host. */
export function isClaimInFlight(questId: string): boolean {
  return claimsInFlight.has(questId)
}

/** Advance quests for a pet/goal event kind (rolls the day lazily first). */
export function handleQuestEvent(eventKind: string): void {
  if (!state || !effects) return
  const today = ensureDay(state, localDayKey((effects.now ?? Date.now)()))
  const next = advanceQuests(today, eventKind)
  if (next !== state) setState(next)
}

/**
 * Claim a completed quest; grants the reward through the host effect.
 *
 * Resolves what was granted, or `null` when there was nothing to claim — an
 * unknown, unfinished or already-claimed quest, or a claim for the same quest
 * that is still in flight. Rejects when the grant fails, after reporting it
 * through `reportClaimFailure`; the quest stays claimable.
 */
export async function claimQuestReward(
  questId: string
): Promise<{ grantedXp: number; grantedCoins: number } | null> {
  if (!state || !effects) return null
  // A double tap must not be granted twice: nothing is marked claimed until
  // the grant lands, so without this guard both calls pass the "not claimed
  // yet" check below.
  if (claimsInFlight.has(questId)) return null
  const { reward } = claimQuest(state, questId)
  if (!reward) return null

  const host = effects
  const token = {}
  claimsInFlight.set(questId, token)
  notify()
  try {
    // Grant FIRST, mark claimed only on success. `effects.reward` routes to
    // `ctx.pet.emitEvent`, which throws on the plugin rate limiter and on a
    // denied `pet:interact` grant; marking first burnt the quest permanently
    // for zero reward whenever that happened.
    const granted = await host.reward(reward)
    // Apply the claim to the state as it is NOW. Pet events keep advancing
    // other quests while the grant is awaited, and writing back a snapshot
    // computed before the await would silently undo that progress.
    if (state && effects === host) {
      const { state: next } = claimQuest(state, questId)
      setState(next)
    }
    return granted
  } catch (error) {
    if (effects === host) host.reportClaimFailure(questId, error)
    throw error
  } finally {
    if (claimsInFlight.get(questId) === token) claimsInFlight.delete(questId)
    notify()
  }
}
