// Deterministic locomotion state machine for the desktop overlay pet:
// rest → wander-walk along the work-area bottom → rest, plus a falling mode
// fed by the drag-throw physics. Pure stepping — the hook owns the rAF clock,
// the seeded PRNG, and the Tauri IPC; given the same inputs this produces the
// same walk, which is what makes the whole feature unit-testable in jsdom.

import type { PetFacing, PetWanderRange } from "@/types/pet"
import {
  clampWalkTargetX,
  resolveGroundTop,
  walkBoundsX,
  type WorkAreaRect,
} from "@/lib/pet/overlay-geometry"
import { BALLISTIC_DEFAULTS, stepBallistic, type BallisticParams } from "./ballistics"
import {
  INTERACTION_WINDOW_MS,
  NEAR_RANGE_PX,
  RECHECK_DELAY_MS,
  type WanderTuning,
} from "./wander-config"

export type LocomotionMode = "resting" | "walking" | "falling"

export interface LocomotionFsmState {
  mode: LocomotionMode
  facing: PetFacing
  /** Window top-left, physical px. */
  x: number
  y: number
  /** Velocity while falling, px/s. */
  vx: number
  vy: number
  /** Walk destination (window X), or null outside walking. */
  targetX: number | null
  /** Earliest time the next walk may start; null = not yet scheduled. */
  restUntilMs: number | null
}

export interface LocomotionInput {
  nowMs: number
  /** Freeze everything (dragging / menu open / bubble / hidden / click-through). */
  paused: boolean
  /** Wander master switch (settings AND not reduced motion). */
  wanderEnabled: boolean
  onlyAfterInteraction: boolean
  /** Last user-interaction timestamp, or null when none happened yet. */
  lastInteractionAtMs: number | null
  range: PetWanderRange
  workArea: WorkAreaRect
  /** Overlay window size, physical px. */
  windowWidth: number
  windowHeight: number
  /** Wander pacing with `walkSpeedPxPerSec` already scaled to physical px. */
  tuning: WanderTuning
  /** Uniform [0,1) source (seeded — never Math.random in render paths). */
  rng: () => number
}

/** Walks shorter than this aren't worth standing up for. */
const MIN_WALK_PX = 24

export function createLocomotionState(
  x: number,
  y: number,
  facing: PetFacing = "right"
): LocomotionFsmState {
  return { mode: "resting", facing, x, y, vx: 0, vy: 0, targetX: null, restUntilMs: null }
}

/** Enter falling with the given release velocity (drag-throw hand-off). */
export function beginThrow(state: LocomotionFsmState, vx: number, vy: number): LocomotionFsmState {
  return {
    ...state,
    mode: "falling",
    vx,
    vy,
    targetX: null,
    restUntilMs: null,
    facing: vx < 0 ? "left" : vx > 0 ? "right" : state.facing,
  }
}

/** Draw the next rest interval from the tuning bounds. */
function drawRest(input: LocomotionInput): number {
  const { restMinMs, restMaxMs } = input.tuning
  return input.nowMs + restMinMs + input.rng() * (restMaxMs - restMinMs)
}

/** Draw a wander destination honoring the range setting, clamped on-monitor. */
function drawTarget(input: LocomotionInput, x: number): number {
  const { minX, maxX } = walkBoundsX(input.workArea, input.windowWidth)
  const raw =
    input.range === "near"
      ? x - NEAR_RANGE_PX + input.rng() * (NEAR_RANGE_PX * 2)
      : minX + input.rng() * (maxX - minX)
  return clampWalkTargetX(raw, input.workArea, input.windowWidth)
}

function stepFalling(
  state: LocomotionFsmState,
  input: LocomotionInput,
  dtMs: number
): LocomotionFsmState {
  const { minX, maxX } = walkBoundsX(input.workArea, input.windowWidth)
  const params: BallisticParams = {
    ...BALLISTIC_DEFAULTS,
    groundY: resolveGroundTop(input.workArea, input.windowHeight),
    minX,
    maxX,
  }
  const next = stepBallistic(
    { x: state.x, y: state.y, vx: state.vx, vy: state.vy, settled: false },
    dtMs,
    params
  )
  const facing: PetFacing = next.vx < 0 ? "left" : next.vx > 0 ? "right" : state.facing
  if (next.settled) {
    return {
      ...state,
      mode: "resting",
      facing,
      x: next.x,
      y: next.y,
      vx: 0,
      vy: 0,
      restUntilMs: null,
    }
  }
  return { ...state, facing, x: next.x, y: next.y, vx: next.vx, vy: next.vy }
}

function stepResting(state: LocomotionFsmState, input: LocomotionInput): LocomotionFsmState {
  if (input.paused || !input.wanderEnabled) return state
  if (state.restUntilMs == null) return { ...state, restUntilMs: drawRest(input) }
  if (input.nowMs < state.restUntilMs) return state

  // "Only move after a recent interaction" gate — re-check shortly instead of
  // burning the drawn rest interval.
  if (input.onlyAfterInteraction) {
    const last = input.lastInteractionAtMs
    if (last == null || input.nowMs - last > INTERACTION_WINDOW_MS) {
      return { ...state, restUntilMs: input.nowMs + RECHECK_DELAY_MS }
    }
  }

  // Off the ground (user parked the pet mid-screen) → drop to the floor first;
  // the landing re-enters resting and the next walk starts from there.
  const groundY = resolveGroundTop(input.workArea, input.windowHeight)
  if (state.y < groundY - 1) {
    return { ...state, mode: "falling", vx: 0, vy: 0, targetX: null, restUntilMs: null }
  }

  const targetX = drawTarget(input, state.x)
  if (Math.abs(targetX - state.x) < MIN_WALK_PX) {
    return { ...state, restUntilMs: drawRest(input) }
  }
  return {
    ...state,
    mode: "walking",
    targetX,
    restUntilMs: null,
    facing: targetX < state.x ? "left" : "right",
    y: groundY,
  }
}

function stepWalking(
  state: LocomotionFsmState,
  input: LocomotionInput,
  dtMs: number
): LocomotionFsmState {
  // Interruptions stop the walk in place; the next rest gets rescheduled.
  if (input.paused || !input.wanderEnabled || state.targetX == null) {
    return { ...state, mode: "resting", targetX: null, restUntilMs: null }
  }
  const groundY = resolveGroundTop(input.workArea, input.windowHeight)
  const dir = state.targetX < state.x ? -1 : 1
  const stepPx = (input.tuning.walkSpeedPxPerSec * dtMs) / 1000
  const nextX = state.x + dir * stepPx
  const arrived = dir === 1 ? nextX >= state.targetX : nextX <= state.targetX
  if (arrived) {
    return {
      ...state,
      mode: "resting",
      x: state.targetX,
      y: groundY,
      targetX: null,
      restUntilMs: null,
    }
  }
  return {
    ...state,
    x: nextX,
    y: groundY,
    facing: dir === -1 ? "left" : "right",
  }
}

/** Advance the FSM by one frame. Pure — returns a new state. */
export function stepLocomotion(
  state: LocomotionFsmState,
  input: LocomotionInput,
  dtMs: number
): LocomotionFsmState {
  switch (state.mode) {
    case "falling":
      return input.paused ? state : stepFalling(state, input, dtMs)
    case "resting":
      return stepResting(state, input)
    case "walking":
      return stepWalking(state, input, dtMs)
  }
}
