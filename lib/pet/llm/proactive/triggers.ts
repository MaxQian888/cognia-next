// Pure trigger evaluators for the three proactive speech classes. Each takes
// explicit inputs (clock injected as ms) and returns a Decision or null —
// no storage, no React, no Date.now().
//
// Topic seeds are English instructions for the utility LLM; the persona layer
// (lib/pet/llm/persona.ts) tells the model to answer in the user's language.

import type { PetEvent, PetEventKind, PetNeeds } from "@/types/pet"

export type ProactiveTrigger = "event" | "idle" | "greeting"

export interface ProactiveDecision {
  trigger: ProactiveTrigger
  /** What to ask the LLM to react to (PII-gated by the caller before send). */
  topicSeed: string
  /** For greetings: the dedupe key to record via `applySpoke`. */
  greetingWindowKey?: string
}

/**
 * Milestone kinds the proactive engine claims from the template bubble path
 * while enabled. High-frequency radar kinds (success/error) are deliberately
 * absent — commenting on every agent turn would be unbearable.
 */
export const PROACTIVE_CLAIMED_KINDS: readonly PetEventKind[] = [
  "levelUp",
  "evolved",
  "goalComplete",
  "achievementUnlocked",
  "workflowRun",
  // A due scheduled task/reminder: the pet says the reminder out loud when
  // proactive is on, else `usePetBubbles` shows the template. `scheduledRunStarting`
  // is intentionally NOT claimed — a spoken line on every run start is too chatty.
  "scheduledRunDue",
] as const

const EVENT_SEEDS: Partial<Record<PetEventKind, string>> = {
  levelUp: "You just leveled up. Celebrate in one short line.",
  evolved: "You just evolved into a new stage. React with wonder in one short line.",
  goalComplete: "Your human just completed a goal. Congratulate them in one short line.",
  achievementUnlocked: "You two just unlocked an achievement badge. Cheer in one short line.",
  workflowRun: "A workflow your human set up just ran. Comment on it in one short line.",
  scheduledRunDue:
    "A scheduled task your human set up is due right now. Remind them about it in one short line.",
}

/**
 * Event-comment trigger: fires only for claimed kinds with an authored seed.
 *
 * The high-frequency `workflowRun` kind additionally passes a deterministic
 * wisdom gate: a wiser pet comments on more of the runs (25% at wisdom 0 up
 * to 100% at wisdom 100), seeded from the event time. Milestone kinds always
 * fire. With `opts` omitted the gate is wide open (back-compat).
 */
export function evaluateEventComment(
  event: PetEvent,
  opts?: { wisdom?: number }
): ProactiveDecision | null {
  if (!PROACTIVE_CLAIMED_KINDS.includes(event.kind)) return null
  const topicSeed = EVENT_SEEDS[event.kind]
  if (!topicSeed) return null
  if (event.kind === "workflowRun" && opts) {
    const wisdom = Math.max(0, Math.min(100, opts.wisdom ?? 100))
    const roll = Math.abs(Math.trunc(event.at)) % 100
    if (roll >= 25 + 75 * (wisdom / 100)) return null
  }
  return { trigger: "event", topicSeed }
}

export interface EvaluateIdleInput {
  nowMs: number
  /** Last user activity (pet interaction or main-window activity), or null. */
  lastActivityAtMs: number | null
  needs: PetNeeds
  idleThresholdMs: number
}

/** Idle-chatter trigger: user has been inactive past the tier threshold. */
export function evaluateIdle(input: EvaluateIdleInput): ProactiveDecision | null {
  if (input.lastActivityAtMs === null) return null
  if (input.nowMs - input.lastActivityAtMs < input.idleThresholdMs) return null

  // Seed from the most pressing need so chatter reflects the nurture loop.
  const { energy, mood, bond } = input.needs
  let topicSeed = "Nothing is happening and you are a little bored. Say something playful."
  const lowest = Math.min(energy, mood, bond)
  if (lowest < 35) {
    if (lowest === energy) topicSeed = "You are low on energy and sleepy. Say so in one cute line."
    else if (lowest === mood)
      topicSeed = "Your mood is low and you want attention. Say so in one gentle line."
    else topicSeed = "You miss your human and want to bond. Say so in one affectionate line."
  }
  return { trigger: "idle", topicSeed }
}

/** Greeting windows: local-hour ranges, each usable once per day. */
const GREETING_WINDOWS: ReadonlyArray<{ id: string; from: number; to: number; seed: string }> = [
  {
    id: "morning",
    from: 5,
    to: 11,
    seed: "It is morning and your human just showed up. Greet them warmly in one short line.",
  },
  {
    id: "lateNight",
    from: 23,
    to: 28, // 23:00–04:00 next day (hours ≥24 wrap)
    seed: "It is very late at night. Gently remind your human to rest, in one caring line.",
  },
]

export interface EvaluateGreetingInput {
  nowMs: number
  /** Already-used window keys (from ProactiveState.greetedWindows). */
  greetedWindows: readonly string[]
  /** Local day key for `nowMs` (computed by the caller via localDayKey). */
  dayKey: string
  /** Local hour 0–23 for `nowMs` (computed by the caller). */
  hour: number
}

/** Time-greeting trigger: once per window per local day. */
export function evaluateGreeting(input: EvaluateGreetingInput): ProactiveDecision | null {
  for (const w of GREETING_WINDOWS) {
    const inWindow =
      w.to > 24
        ? input.hour >= w.from || input.hour < w.to - 24
        : input.hour >= w.from && input.hour < w.to
    if (!inWindow) continue
    const key = `${input.dayKey}:${w.id}`
    if (input.greetedWindows.includes(key)) continue
    return { trigger: "greeting", topicSeed: w.seed, greetingWindowKey: key }
  }
  return null
}
