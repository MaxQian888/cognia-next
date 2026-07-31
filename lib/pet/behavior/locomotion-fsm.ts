// Deterministic locomotion state machine for the desktop overlay pet:
// rest → wander-walk along the work-area bottom → rest, plus a falling mode
// fed by the drag-throw physics. Pure stepping — the hook owns the rAF clock,
// the seeded PRNG, and the Tauri IPC; given the same inputs this produces the
// same walk, which is what makes the whole feature unit-testable in jsdom.

import type { PetFacing, PetWanderRange } from "@/types/pet"
import {
  isOnPlatform,
  nearestSupportBelow,
  platformBoundsX,
  reachablePlatformAbove,
  resolveGroundTop,
  resolvePlatformTop,
  samePlatform,
  walkBoundsX,
  type Platform,
  type WorkAreaRect,
} from "@/lib/pet/overlay-geometry"
import { BALLISTIC_DEFAULTS, stepBallistic, type BallisticParams } from "./ballistics"
import {
  INTERACTION_WINDOW_MS,
  NEAR_RANGE_PX,
  RECHECK_DELAY_MS,
  type WanderTuning,
} from "./wander-config"

export type LocomotionMode = "resting" | "walking" | "falling" | "climbing"

/** Base duration of the hop-up climb tween, ms (short rises). */
export const CLIMB_MS_BASE = 280
/** Extra climb time per physical px of rise (taller hops take longer). */
export const CLIMB_MS_PER_PX = 1.2
/** Climb duration ceiling, ms. */
export const CLIMB_MS_MAX = 700
/** Max vertical rise the pet will hop up to perch on a platform, physical px. */
export const HOP_RISE_PX = 160
/** Chance per rest cycle (floor only) of attempting a climb when one is reachable. */
export const CLIMB_PROBABILITY = 0.35

/** Rise-scaled climb duration: a 20px hop is quick, a 160px scramble isn't. */
export function climbDurationMs(risePx: number): number {
  const raw = CLIMB_MS_BASE + Math.abs(risePx) * CLIMB_MS_PER_PX
  return Math.min(CLIMB_MS_MAX, Math.max(CLIMB_MS_BASE, raw))
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** Walk speed shaping: ramp up over the first stretch, brake near the target. */
const WALK_ACCEL_MS = 300
const WALK_DECEL_ZONE_PX = 48
const WALK_MIN_FACTOR = 0.35

/**
 * Current walk-speed factor (0–1] from the accel ramp + arrival braking.
 * Pure and exported so the render hook publishes the same effective speed
 * the FSM steps with (the skin syncs its bob cadence to it).
 */
export function resolveWalkSpeedFactor(
  walkStartMs: number | null,
  nowMs: number,
  distToTargetPx: number
): number {
  const rampUp = walkStartMs != null ? Math.min(1, (nowMs - walkStartMs) / WALK_ACCEL_MS) : 1
  const brake = Math.min(1, distToTargetPx / WALK_DECEL_ZONE_PX)
  return Math.max(WALK_MIN_FACTOR, Math.min(rampUp, brake))
}

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
  /** When the current walk began (accel ramp), or null outside walking. */
  walkStartMs: number | null
  /** Earliest time the next walk may start; null = not yet scheduled. */
  restUntilMs: number | null
  /** Platform currently perched on / climbing to, or null when on the floor. */
  platform: Platform | null
  /** Climb tween start time + origin Y (climbing mode only). */
  climbFromY: number | null
  climbStartMs: number | null
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
  /** Perchable window-top platforms (physical px). Empty = floor-only behavior. */
  platforms: Platform[]
  /** Climb-onto-windows opt-in. False (or empty platforms) = today's behavior. */
  climbEnabled: boolean
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
  return {
    mode: "resting",
    facing,
    x,
    y,
    vx: 0,
    vy: 0,
    targetX: null,
    walkStartMs: null,
    restUntilMs: null,
    platform: null,
    climbFromY: null,
    climbStartMs: null,
  }
}

/** Enter falling with the given release velocity (drag-throw hand-off). */
export function beginThrow(state: LocomotionFsmState, vx: number, vy: number): LocomotionFsmState {
  return {
    ...state,
    mode: "falling",
    vx,
    vy,
    targetX: null,
    walkStartMs: null,
    restUntilMs: null,
    platform: null, // a throw leaves any perch
    climbFromY: null,
    climbStartMs: null,
    facing: vx < 0 ? "left" : vx > 0 ? "right" : state.facing,
  }
}

/** The platform the pet is genuinely perched on right now (still present + under
 *  the window center), or null when it has vanished / the pet walked off it. */
function activePlatform(state: LocomotionFsmState, input: LocomotionInput): Platform | null {
  if (!state.platform) return null
  const match = input.platforms.find((p) => samePlatform(p, state.platform))
  if (!match) return null
  if (!isOnPlatform(state.x, input.windowWidth, match)) return null
  return match
}

/** Window-top Y the pet rests on: its active platform, else the floor. */
function supportTop(state: LocomotionFsmState, input: LocomotionInput): number {
  const p = activePlatform(state, input)
  if (p) return resolvePlatformTop(p, input.windowHeight)
  return resolveGroundTop(input.workArea, input.windowHeight)
}

/** A forced drop when the perched platform moved or vanished. */
function dropOff(state: LocomotionFsmState): LocomotionFsmState {
  return {
    ...state,
    mode: "falling",
    platform: null,
    vx: 0,
    vy: 0,
    targetX: null,
    walkStartMs: null,
    restUntilMs: null,
    climbFromY: null,
    climbStartMs: null,
  }
}

/** Draw the next rest interval from the tuning bounds. */
function drawRest(input: LocomotionInput): number {
  const { restMinMs, restMaxMs } = input.tuning
  return input.nowMs + restMinMs + input.rng() * (restMaxMs - restMinMs)
}

/** Draw a wander destination within the given X bounds (platform or work area). */
function drawTarget(
  input: LocomotionInput,
  x: number,
  bounds: { minX: number; maxX: number }
): number {
  const raw =
    input.range === "near"
      ? x - NEAR_RANGE_PX + input.rng() * (NEAR_RANGE_PX * 2)
      : bounds.minX + input.rng() * (bounds.maxX - bounds.minX)
  return Math.min(bounds.maxX, Math.max(bounds.minX, raw))
}

function stepFalling(
  state: LocomotionFsmState,
  input: LocomotionInput,
  dtMs: number
): LocomotionFsmState {
  const { minX, maxX } = walkBoundsX(input.workArea, input.windowWidth)
  const floorTop = resolveGroundTop(input.workArea, input.windowHeight)
  // Land on the highest surface below the current position — a window top or the
  // floor (drag-throw onto a window perches the pet there).
  const support = nearestSupportBelow(
    state.y,
    state.x,
    input.windowWidth,
    input.windowHeight,
    input.platforms,
    floorTop
  )
  const params: BallisticParams = {
    ...BALLISTIC_DEFAULTS,
    groundY: support.top,
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
      platform: support.platform,
    }
  }
  return { ...state, facing, x: next.x, y: next.y, vx: next.vx, vy: next.vy }
}

function stepResting(state: LocomotionFsmState, input: LocomotionInput): LocomotionFsmState {
  if (input.paused || !input.wanderEnabled) return state
  // A perched platform that moved or vanished → drop to whatever is below.
  if (state.platform && !activePlatform(state, input)) return dropOff(state)
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

  // Off the current support (user parked the pet mid-screen) → drop first; the
  // landing re-enters resting and the next walk starts from there.
  const groundY = supportTop(state, input)
  if (state.y < groundY - 1) {
    return {
      ...state,
      mode: "falling",
      vx: 0,
      vy: 0,
      targetX: null,
      walkStartMs: null,
      restUntilMs: null,
    }
  }

  // Climb attempt — floor only, opt-in, when a window top is hop-reachable.
  if (input.climbEnabled && !state.platform && input.platforms.length > 0) {
    if (input.rng() < CLIMB_PROBABILITY) {
      const target = reachablePlatformAbove(
        groundY,
        state.x,
        input.windowWidth,
        input.windowHeight,
        input.platforms,
        HOP_RISE_PX
      )
      if (target) {
        return {
          ...state,
          mode: "climbing",
          platform: target,
          targetX: null,
          restUntilMs: null,
          climbFromY: state.y,
          climbStartMs: input.nowMs,
        }
      }
    }
  }

  const perched = activePlatform(state, input)
  const bounds = perched
    ? platformBoundsX(perched, input.windowWidth)
    : walkBoundsX(input.workArea, input.windowWidth)
  const targetX = drawTarget(input, state.x, bounds)
  if (Math.abs(targetX - state.x) < MIN_WALK_PX) {
    return { ...state, restUntilMs: drawRest(input) }
  }
  return {
    ...state,
    mode: "walking",
    targetX,
    walkStartMs: input.nowMs,
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
    return { ...state, mode: "resting", targetX: null, walkStartMs: null, restUntilMs: null }
  }
  // A perch that moved/vanished mid-walk → drop.
  if (state.platform && !activePlatform(state, input)) return dropOff(state)
  const groundY = supportTop(state, input)
  const dir = state.targetX < state.x ? -1 : 1
  // Accel/decel shaping: ramp up from standstill, brake into the target —
  // kills both the constant-velocity glide and the arrival snap.
  const factor = resolveWalkSpeedFactor(
    state.walkStartMs,
    input.nowMs,
    Math.abs(state.targetX - state.x)
  )
  const stepPx = (input.tuning.walkSpeedPxPerSec * factor * dtMs) / 1000
  const nextX = state.x + dir * stepPx
  const arrived = dir === 1 ? nextX >= state.targetX : nextX <= state.targetX
  if (arrived) {
    return {
      ...state,
      mode: "resting",
      x: state.targetX,
      y: groundY,
      targetX: null,
      walkStartMs: null,
      restUntilMs: null,
    }
  }
  // Walked past the platform edge → fall off to the floor / lower surface.
  if (state.platform) {
    const perched = input.platforms.find((p) => samePlatform(p, state.platform))
    if (perched && !isOnPlatform(nextX, input.windowWidth, perched)) {
      return { ...dropOff(state), x: nextX, facing: dir === -1 ? "left" : "right" }
    }
  }
  return {
    ...state,
    x: nextX,
    y: groundY,
    facing: dir === -1 ? "left" : "right",
  }
}

/** Tween the window up onto its target platform top — rise-scaled duration,
 *  ease-out so the hop launches fast and settles gently (the linear constant-
 *  duration version read as a slow elevator). */
function stepClimbing(state: LocomotionFsmState, input: LocomotionInput): LocomotionFsmState {
  // Target platform vanished mid-climb → abandon and drop.
  if (!state.platform || !input.platforms.some((p) => samePlatform(p, state.platform))) {
    return dropOff(state)
  }
  const targetTop = resolvePlatformTop(state.platform, input.windowHeight)
  const from = state.climbFromY ?? state.y
  const start = state.climbStartMs ?? input.nowMs
  const durationMs = climbDurationMs(targetTop - from)
  const t = durationMs > 0 ? Math.min(1, Math.max(0, (input.nowMs - start) / durationMs)) : 1
  const y = from + (targetTop - from) * easeOutCubic(t)
  if (t >= 1) {
    return {
      ...state,
      mode: "resting",
      y: targetTop,
      restUntilMs: null,
      climbFromY: null,
      climbStartMs: null,
    }
  }
  return { ...state, y }
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
    case "climbing":
      return input.paused ? state : stepClimbing(state, input)
  }
}
