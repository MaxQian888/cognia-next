// Drives the one-shot animation queue. The resting visual state comes straight
// from the store (set by the event reducer); this hook plays at most one queued
// one-shot at a time for its natural duration, then returns to rest. Under
// reduced motion it silently drains the queue without playing anything.

"use client"

import { useEffect, useRef, useState } from "react"
import { usePetStore } from "@/stores/pet/pet-store"
import { resolvePetMotion } from "@/lib/pet/animation/motion-spec"
import type { PetOneShot, PetVisualState } from "@/types/pet"

export interface PetAnimationState {
  state: PetVisualState
  oneShot: PetOneShot | null
}

export interface UsePetAnimationStateOptions {
  /**
   * Minimum ms a one-shot holds before the queue advances. The natural
   * durations come from the SVG motion specs; the Live2D skin passes a floor
   * (`LIVE2D_ONE_SHOT_HOLD_MS`) so its longer Cubism motions aren't force-cut
   * on the SVG clock.
   */
  holdFloorMs?: number
}

function oneShotDurationMs(shot: PetOneShot, holdFloorMs = 0): number {
  return Math.max(holdFloorMs, resolvePetMotion("idle", shot, false, "dot").durationSec * 1000)
}

export function usePetAnimationState(
  reducedMotion = false,
  options: UsePetAnimationStateOptions = {}
): PetAnimationState {
  const visualState = usePetStore((s) => s.visualState)
  const queueLength = usePetStore((s) => s.oneShotQueue.length)
  const dequeueOneShot = usePetStore((s) => s.dequeueOneShot)
  const [current, setCurrent] = useState<PetOneShot | null>(null)
  // The play timer is held in a ref so the re-render that sets `current` does not
  // cancel it via effect cleanup; it is only cleared on unmount.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read through a ref so a skin switch mid-play never re-binds the effect.
  const holdFloorRef = useRef(options.holdFloorMs ?? 0)
  useEffect(() => {
    holdFloorRef.current = options.holdFloorMs ?? 0
  }, [options.holdFloorMs])

  useEffect(() => {
    if (current) return // a one-shot is already playing
    if (queueLength === 0) return
    const next = dequeueOneShot()
    if (!next) return
    if (reducedMotion) return // drained without playing; effect re-runs for the rest
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional queue-driven state machine: dequeues one queued one-shot and marks it playing until the timer fires.
    setCurrent(next)
    timerRef.current = setTimeout(
      () => setCurrent(null),
      oneShotDurationMs(next, holdFloorRef.current)
    )
  }, [current, queueLength, dequeueOneShot, reducedMotion])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { state: visualState, oneShot: reducedMotion ? null : current }
}
