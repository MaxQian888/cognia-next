// Pure resolver mapping a semantic pet state (+ optional one-shot) to a Live2D
// MotionPlan. Mirrors `resolvePetMotion` (lib/pet/animation/motion-spec.ts) but
// targets motion groups / expressions instead of keyframes. Live2D models name
// their motion groups by convention (Idle / Tap / TapBody / Tap@Body / Flick /
// TapHead / Special / Greeting); we keep an ordered candidate list per state and
// pick the first one the loaded model actually exposes, with a graceful fallback
// to the engine's native breathing / eye-blink when nothing matches.

import type {
  Live2dMotionOverride,
  Live2dMotionOverrides,
  PetOneShot,
  PetVisualState,
} from "@/types/pet"
import { overrideKeyFor } from "./state-keys"
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

/** Resting-state intent table (12 states). */
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
  unwell: { groups: ["Idle"], expressions: ["sad", "sleepy", "f03"] },
}

/** One-shot intent table (10 shots). One-shot present always wins at force. */
const ONE_SHOT_INTENT: Record<PetOneShot, Intent> = {
  wave: { groups: ["Tap", "TapBody", "Greeting"] },
  happy: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  fed: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  petted: { groups: ["TapBody", "Tap@Body", "TapHead", "Tap"] },
  evolving: { groups: ["Special", "TapHead", "TapBody"] },
  levelUp: { groups: ["Special", "TapHead", "TapBody"] },
  // emotion flourishes from LLM reply tags
  sad: { groups: ["Flick", "Flick@Body", "Idle"], expressions: ["sad", "f03"] },
  surprised: { groups: ["Flick", "FlickUp", "Tap"], expressions: ["surprised", "f02"] },
  love: { groups: ["TapHead", "TapBody", "Tap"], expressions: ["love", "heart", "happy", "f01"] },
  sleepy: { groups: ["Idle"], expressions: ["sleepy", "blank"] },
  // Impact squash after a throw/fall settles — flick-ish reaction reads best.
  land: { groups: ["Flick", "Flick@Body", "Shake", "TapBody"], expressions: ["surprised", "f02"] },
  // Shell-crack celebration on hatch.
  hatch: { groups: ["Special", "Tap", "TapBody"], expressions: ["happy", "smile", "f01"] },
}

/** Resting states that should play at idle priority rather than normal. */
const IDLE_PRIORITY_STATES: ReadonlySet<PetVisualState> = new Set(["idle", "sleeping", "sad"])

/** Candidate motion groups for desktop-overlay locomotion (walking). */
const WALK_GROUPS = ["Walk", "Walking", "Move", "Run", "Idle"]

/**
 * Plan for the wandering walk. Prefers a real walk-ish motion group when the
 * model ships one, else falls back to Idle / engine breathing — the window
 * movement itself carries the locomotion. Idle priority so any emotion or
 * one-shot motion preempts it.
 */
export function resolveLive2dWalkPlan(
  caps: Live2dCapabilities,
  reducedMotion: boolean
): MotionPlan {
  if (reducedMotion) {
    return { priority: "idle", parameterFallback: false }
  }
  const motionGroup = firstMatch(WALK_GROUPS, caps.motionGroups)
  const plan: MotionPlan = {
    priority: "idle",
    parameterFallback: motionGroup === undefined,
  }
  if (motionGroup !== undefined) {
    plan.motionGroup = motionGroup
    plan.motionIndex = 0
  }
  return plan
}

/**
 * Build a plan from a user-authored override entry, or null when the entry is
 * unusable (references a group the model no longer exposes → fall through to
 * the convention tables). An EMPTY entry ({}) is the explicit "engine default":
 * no motion, no expression, parameterFallback.
 */
function planFromOverride(
  override: Live2dMotionOverride,
  caps: Live2dCapabilities,
  priority: MotionPlan["priority"]
): MotionPlan | null {
  const wantsGroup = override.motionGroup !== undefined
  const groupAvailable = wantsGroup && caps.motionGroups.includes(override.motionGroup!)
  // A dangling group reference invalidates the entry — convention takes over.
  if (wantsGroup && !groupAvailable) return null

  const plan: MotionPlan = {
    priority,
    parameterFallback: !wantsGroup,
  }
  if (groupAvailable) {
    plan.motionGroup = override.motionGroup
    // undefined motionIndex = "random each play"; the HOOK draws the index at
    // play time (this resolver stays pure/deterministic).
    if (override.motionIndex !== undefined) plan.motionIndex = override.motionIndex
  }
  if (override.expressionId !== undefined && caps.expressionIds.includes(override.expressionId)) {
    plan.expressionId = override.expressionId
  }
  return plan
}

/**
 * Resolve the motion plan for the current state. `reducedMotion` collapses to a
 * still plan (idle priority, no group, no expression) so the model rests on its
 * native breathing without forcing any motion. A per-model override entry for
 * the active key (see `overrideKeyFor`) fully governs that key; unset keys use
 * the naming-convention tables.
 */
export function resolveLive2dPlan(
  state: PetVisualState,
  oneShot: PetOneShot | null,
  caps: Live2dCapabilities,
  reducedMotion: boolean,
  overrides?: Live2dMotionOverrides
): MotionPlan {
  if (reducedMotion) {
    return { priority: "idle", parameterFallback: false }
  }

  const priority: MotionPlan["priority"] = oneShot
    ? "force"
    : IDLE_PRIORITY_STATES.has(state)
      ? "idle"
      : "normal"

  const override = overrides?.[overrideKeyFor(state, oneShot)]
  if (override) {
    const plan = planFromOverride(override, caps, priority)
    if (plan) return plan
  }

  const intent = oneShot ? ONE_SHOT_INTENT[oneShot] : STATE_INTENT[state]
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
