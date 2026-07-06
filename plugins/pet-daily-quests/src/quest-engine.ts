/**
 * Pure daily-quest engine — no ctx, no Date.now(), no storage. The host shell
 * (`src/index.ts`) feeds it day keys + pet event kinds and persists the
 * returned state; the tab renders it.
 *
 * Reward totals are sized so a fully-cleared day stays comfortably inside the
 * per-plugin daily budget (50 XP / 100 coins) — the ctx.pet API clamps anyway,
 * this just keeps the UI honest.
 */

export interface QuestDef {
  id: string
  /** Pet event kind that advances this quest. */
  target: "fed" | "played" | "petted" | "talked" | "slept" | "cleaned" | "treated" | "goalComplete"
  /** Completions required. */
  count: number
  rewardXp: number
  rewardCoins: number
}

export const QUEST_POOL: readonly QuestDef[] = [
  { id: "feed3", target: "fed", count: 3, rewardXp: 4, rewardCoins: 8 },
  { id: "play2", target: "played", count: 2, rewardXp: 4, rewardCoins: 8 },
  { id: "pet3", target: "petted", count: 3, rewardXp: 3, rewardCoins: 6 },
  { id: "talk2", target: "talked", count: 2, rewardXp: 3, rewardCoins: 6 },
  { id: "sleep1", target: "slept", count: 1, rewardXp: 3, rewardCoins: 5 },
  { id: "clean1", target: "cleaned", count: 1, rewardXp: 3, rewardCoins: 5 },
  { id: "treat1", target: "treated", count: 1, rewardXp: 3, rewardCoins: 5 },
  { id: "goal1", target: "goalComplete", count: 1, rewardXp: 6, rewardCoins: 12 },
] as const

export interface QuestProgress {
  id: string
  progress: number
  done: boolean
  claimed: boolean
}

export interface QuestState {
  /** Local day key (YYYY-MM-DD) the quests were rolled for. */
  day: string
  quests: QuestProgress[]
}

export function questDef(id: string): QuestDef | undefined {
  return QUEST_POOL.find((q) => q.id === id)
}

/** Deterministic non-negative hash of a day string (no Math.random). */
function hashDay(day: string): number {
  let h = 2166136261
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** Roll the day's 3 quests — same day always yields the same picks. */
export function rollDailyQuests(day: string): QuestDef[] {
  const picked: QuestDef[] = []
  const pool = [...QUEST_POOL]
  let seed = hashDay(day)
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const index = seed % pool.length
    picked.push(pool.splice(index, 1)[0])
    // Advance the seed deterministically between picks.
    seed = Math.abs(Math.imul(seed ^ (index + 1), 16777619))
  }
  return picked
}

/** Lazy day rollover: re-roll when the stored state is for another day. */
export function ensureDay(state: QuestState | undefined, day: string): QuestState {
  if (state && state.day === day && Array.isArray(state.quests)) return state
  return {
    day,
    quests: rollDailyQuests(day).map((q) => ({
      id: q.id,
      progress: 0,
      done: false,
      claimed: false,
    })),
  }
}

/** Advance every quest targeting `eventKind` (immutable; no-op otherwise). */
export function advanceQuests(state: QuestState, eventKind: string): QuestState {
  let changed = false
  const quests = state.quests.map((q) => {
    const def = questDef(q.id)
    if (!def || def.target !== eventKind || q.done) return q
    changed = true
    const progress = q.progress + 1
    return { ...q, progress, done: progress >= def.count }
  })
  return changed ? { ...state, quests } : state
}

/** Claim a completed quest. Returns the reward once; re-claims yield null. */
export function claimQuest(
  state: QuestState,
  questId: string
): { state: QuestState; reward: { xp: number; coins: number } | null } {
  const quest = state.quests.find((q) => q.id === questId)
  const def = questDef(questId)
  if (!quest || !def || !quest.done || quest.claimed) return { state, reward: null }
  return {
    state: {
      ...state,
      quests: state.quests.map((q) => (q.id === questId ? { ...q, claimed: true } : q)),
    },
    reward: { xp: def.rewardXp, coins: def.rewardCoins },
  }
}

/** Local calendar day key for an epoch-ms timestamp. */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}
