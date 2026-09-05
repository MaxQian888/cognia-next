"use client"

import { useInView, useReducedMotion } from "motion/react"
import type { RefObject } from "react"

import { useHasMounted } from "./use-has-mounted"
import { useScriptedPhases } from "./use-scripted-phases"

interface SceneOptions {
  /** How much of the element must be visible before the sequence starts. */
  amount?: number
}

export interface Scene {
  /** True while the sequence is allowed to run: hydrated, on screen, motion permitted. */
  live: boolean
  /**
   * The phase to render. Counts up once the scene is live. Before the surface
   * is on screen it holds the opening phase, so the reader never sees the
   * finished picture flash to empty as the sequence starts. It reports the
   * final phase when the sequence will not play at all: reduced motion, or
   * markup rendered without JavaScript.
   */
  phase: number
}

/**
 * A scripted sequence that starts when its surface reaches the viewport.
 *
 * Three surfaces on the site build themselves up in phases when the reader
 * arrives, and each had to combine the same four facts: has the page hydrated,
 * did the reader ask for reduced motion, is the element on screen, which phase
 * is the clock at. This hook is that combination, once. The caller owns the
 * ref (the React compiler treats an object that carries a ref as a ref, so
 * returning one from here would make every read of `live` a lint error). It is one-shot like
 * `useScriptedPhases` beneath it, and it never reports an empty first frame
 * to a reader the sequence is not going to play for.
 */
export function useScene(
  ref: RefObject<HTMLElement | null>,
  delays: readonly number[],
  { amount = 0.3 }: SceneOptions = {}
): Scene {
  const reduced = useReducedMotion() ?? false
  const mounted = useHasMounted()
  const inView = useInView(ref, { once: true, amount })
  const live = mounted && !reduced && inView
  const phase = useScriptedPhases({ delays, enabled: live })
  const willPlay = mounted && !reduced
  return { live, phase: live ? phase : willPlay ? 0 : delays.length }
}
