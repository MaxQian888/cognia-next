// Drives a loaded Live2D model from the pet's semantic (state, oneShot) by
// diffing against a ref each render and applying `resolveLive2dPlan`. Motions
// fire through `model.motion(group, index, priority)` and expressions through
// `model.expression(id)`. One-shots are edge-triggered (fire once on the
// transition to a non-null shot). The numeric MotionPriority map is local —
// the engine enum is never imported here so this hook stays bundle-light and
// test-friendly (the engine import lives only inside the loader).

"use client"

import { useEffect, useRef } from "react"
import type { Live2dMotionOverrides, PetOneShot, PetVisualState } from "@/types/pet"
import { resolveLive2dPlan, resolveLive2dWalkPlan } from "@/lib/pet/live2d/state-mapping"
import type { Live2dCapabilities, MotionPlan } from "@/lib/pet/live2d/types"

/** Structural slice of a loaded Live2D model the motion driver needs. */
export interface Live2dModelLike {
  motion(group: string, index?: number, priority?: number): unknown
  expression(id?: number | string): unknown
  internalModel?: {
    motionManager?: {
      stopAllMotions?: () => void
      on?(event: string, handler: () => void): unknown
      off?(event: string, handler: () => void): unknown
    }
  }
}

// Mirrors the engine's MotionPriority enum (NONE=0, IDLE=1, NORMAL=2, FORCE=3)
// without importing it — keeps the engine out of this module's graph.
const PRIORITY_VALUE: Record<MotionPlan["priority"], number> = {
  idle: 1,
  normal: 2,
  force: 3,
}

/**
 * Apply a resolved plan to the model. A plan with a group but no index means
 * "random each play" (the override editor's Random option) — the index is
 * drawn here, at play time, from the group's motion count when known.
 */
function applyPlan(
  model: Live2dModelLike,
  plan: MotionPlan,
  caps: Live2dCapabilities,
  random: () => number = Math.random
): void {
  if (plan.expressionId !== undefined) {
    model.expression(plan.expressionId)
  }
  // parameterFallback === true means no motion matched: leave the engine's
  // native breathing / eye-blink in control rather than forcing a motion.
  if (!plan.parameterFallback && plan.motionGroup !== undefined) {
    let index = plan.motionIndex
    if (index === undefined) {
      const count = caps.motionGroupCounts?.[plan.motionGroup] ?? 0
      index = count > 1 ? Math.floor(random() * count) : 0
    }
    model.motion(plan.motionGroup, index, PRIORITY_VALUE[plan.priority])
  }
}

/** True when a plan's motion group is the model's own auto-looping Idle. */
function isIdleGroup(plan: MotionPlan): boolean {
  return (plan.motionGroup ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase() === "idle"
}

/**
 * Reactively map (state, oneShot) onto motions/expressions of a loaded model.
 *
 * - State changes apply a fresh plan (idle/normal priority).
 * - One-shots are edge-triggered: a plan fires only on the transition into a
 *   non-null shot (so a re-render with the same active shot doesn't replay it).
 * - `walking` (overlay wandering) plays the model's walk-ish group at idle
 *   priority while it lasts; one-shots and reduced motion still win.
 * - Resting/walk plans on a NON-Idle group re-fire when the motion finishes
 *   (`motionFinish`): a persistent happy/greeting/interacting state — and a
 *   whole walk — previously played their Tap/Walk motion exactly once and then
 *   degraded to Idle while the state (or the sliding window) carried on.
 * - `reducedMotion` stops all motions once on entering reduced mode, then no
 *   further motions are applied while it stays on.
 */
export function useLive2dMotion(
  model: Live2dModelLike | null,
  state: PetVisualState,
  oneShot: PetOneShot | null,
  caps: Live2dCapabilities,
  reducedMotion: boolean,
  walking = false,
  overrides?: Live2dMotionOverrides
): void {
  const prevState = useRef<PetVisualState | null>(null)
  const prevOneShot = useRef<PetOneShot | null>(null)
  const prevReduced = useRef<boolean | null>(null)
  const prevWalking = useRef<boolean>(false)
  // The plan to replay when the current motion finishes (null = let the
  // engine's own Idle loop take over). Held in a ref so the motionFinish
  // subscription below never re-binds per plan.
  const loopPlanRef = useRef<{ plan: MotionPlan; caps: Live2dCapabilities } | null>(null)

  // Re-fire looping resting/walk plans when their motion finishes.
  useEffect(() => {
    const manager = model?.internalModel?.motionManager
    if (!model || !manager?.on || !manager.off) return
    const handler = () => {
      const entry = loopPlanRef.current
      if (entry) applyPlan(model, entry.plan, entry.caps)
    }
    manager.on("motionFinish", handler)
    return () => {
      manager.off!("motionFinish", handler)
    }
  }, [model])

  useEffect(() => {
    if (!model) {
      // No model yet — reset diff refs so the first real model gets a fresh plan.
      prevState.current = null
      prevOneShot.current = null
      prevReduced.current = null
      prevWalking.current = false
      return
    }

    const enteringReduced = reducedMotion && prevReduced.current !== true
    prevReduced.current = reducedMotion

    if (reducedMotion) {
      if (enteringReduced) {
        model.internalModel?.motionManager?.stopAllMotions?.()
      }
      // Hold the resting frame; refresh diff refs so leaving reduced re-applies.
      loopPlanRef.current = null
      prevState.current = state
      prevOneShot.current = oneShot
      prevWalking.current = walking
      return
    }

    // Edge-trigger one-shots: fire only when transitioning into a non-null shot.
    const oneShotEntered = oneShot !== null && oneShot !== prevOneShot.current
    const stateChanged = state !== prevState.current
    const leftReduced = enteringReduced === false && prevReduced.current === false
    const walkingChanged = walking !== prevWalking.current

    prevState.current = state
    prevOneShot.current = oneShot
    prevWalking.current = walking

    if (oneShotEntered) {
      // One-shots play once by definition — suspend any loop replay while the
      // shot runs (the state-machine reverting to rest re-arms it below).
      loopPlanRef.current = null
      applyPlan(model, resolveLive2dPlan(state, oneShot, caps, false, overrides), caps)
      return
    }
    // While walking, the walk plan replaces the resting plan (edge-triggered the
    // same way); a finished one-shot falls back into the walk loop too.
    if (walking && oneShot === null) {
      if (walkingChanged || stateChanged || leftReduced) {
        const plan = resolveLive2dWalkPlan(caps, false)
        loopPlanRef.current = !plan.parameterFallback && !isIdleGroup(plan) ? { plan, caps } : null
        applyPlan(model, plan, caps)
      }
      return
    }
    // Only re-apply the resting plan when the state actually changed (or we just
    // left reduced mode / stopped walking) — avoids replaying the same idle
    // motion every render.
    if (oneShot === null && (stateChanged || leftReduced || walkingChanged)) {
      const plan = resolveLive2dPlan(state, null, caps, false, overrides)
      // Non-Idle resting plans (happy → Tap, greeting → Tap, …) replay on
      // motionFinish so the state keeps its expression; Idle-group plans hand
      // off to the engine's own idle loop.
      loopPlanRef.current = !plan.parameterFallback && !isIdleGroup(plan) ? { plan, caps } : null
      applyPlan(model, plan, caps)
    }
  }, [model, state, oneShot, caps, reducedMotion, walking, overrides])
}
