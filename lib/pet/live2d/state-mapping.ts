// Pure resolver mapping a semantic pet state (+ optional one-shot) to a Live2D
// MotionPlan. Mirrors `resolvePetMotion` (lib/pet/animation/motion-spec.ts) but
// targets motion groups / expressions instead of keyframes. Live2D models name
// their motion groups by convention (Idle / Tap / TapBody / Tap@Body / Flick /
// TapHead / Special / Greeting); we keep an ordered candidate list per state and
// pick the first one the loaded model actually exposes, with a graceful fallback
// to the engine's native breathing / eye-blink when nothing matches.

import type { PetOneShot, PetVisualState } from "@/types/pet"
import type { Live2dCapabilities, MotionPlan } from "./types"

/** Strip everything but alphanumerics and lowercase, so "Tap@Body" ≈ "tapbody". */
function canonical(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase()
}

/** First candidate whose canonical form matches an available value. */
function firstMatch(candidates: string[], available: string[]): string | undefined {
  // Build the canonical → original lookup with first-writer-wins so a model
  // exposing two groups that canonicalize the same ("TapBody" + "Tap@Body")
  // resolves deterministically to the first one listed.
  const canonAvailable = new Map<string, string>()
  for (const a of available) {
    const key = canonical(a)
    if (!canonAvailable.has(key)) canonAvailable.set(key, a)
  }
  for (const candidate of candidates) {
    const hit = canonAvailable.get(canonical(candidate))
    if (hit !== undefined) return hit
  }
  return undefined
}

interface Intent {
  /** Ordered candidate motion-group names. */
  groups: string[]
  /** Ordered candidate expression ids. */
  expressions?: string[]
}

/** Resting-state intent table (11 states). */
const STATE_INTENT: Record<PetVisualState, Intent> = {
  idle: { groups: ["Idle"] },
  greeting: { groups: ["Tap", "TapBody", "Tap@Body", "Idle"] },
  happy: { groups: ["TapBody", "Tap@Body", "Tap", "Idle"], expressions: ["happy", "smile", "f01"] },
  sad: { groups: ["Idle"], expressions: ["sad", "f03"] },
  error: { groups: ["Flick", "Flick@Body", "Shake", "Idle"], expressions: ["angry", "f02"] },
  thinking: { groups: ["Idle"] },
  waiting: { groups: ["Idle"] },
  review: { groups: ["Idle"] },
  sleeping: { groups: ["Idle"], expressions: ["sleepy", "blank"] },
  evolving: { groups: ["Special", "TapHead", "Idle"] },
  interacting: { groups: ["Tap", "TapBody", "Idle"] },
}

/** One-shot intent table (6 shots). One-shot present always wins at force. */
const ONE_SHOT_INTENT: Record<PetOneShot, Intent> = {
  wave: { groups: ["Tap", "TapBody", "Greeting"] },
  happy: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  fed: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  petted: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  evolving: { groups: ["Special", "TapHead", "TapBody"] },
  levelUp: { groups: ["Special", "TapHead", "TapBody"] },
}

/** Resting states that should play at idle priority rather than normal. */
const IDLE_PRIORITY_STATES: ReadonlySet<PetVisualState> = new Set(["idle", "sleeping", "sad"])

/**
 * Resolve the motion plan for the current state. `reducedMotion` collapses to a
 * still plan (idle priority, no group, no expression) so the model rests on its
 * native breathing without forcing any motion.
 */
export function resolveLive2dPlan(
  state: PetVisualState,
  oneShot: PetOneShot | null,
  caps: Live2dCapabilities,
  reducedMotion: boolean
): MotionPlan {
  if (reducedMotion) {
    return { priority: "idle", parameterFallback: false }
  }

  const intent = oneShot ? ONE_SHOT_INTENT[oneShot] : STATE_INTENT[state]
  const priority: MotionPlan["priority"] = oneShot
    ? "force"
    : IDLE_PRIORITY_STATES.has(state)
      ? "idle"
      : "normal"

  const motionGroup = firstMatch(intent.groups, caps.motionGroups)
  const expressionId = intent.expressions
    ? firstMatch(intent.expressions, caps.expressionIds)
    : undefined

  const plan: MotionPlan = {
    priority,
    parameterFallback: motionGroup === undefined,
  }
  if (motionGroup !== undefined) {
    plan.motionGroup = motionGroup
    plan.motionIndex = 0
  }
  if (expressionId !== undefined) {
    plan.expressionId = expressionId
  }
  return plan
}
