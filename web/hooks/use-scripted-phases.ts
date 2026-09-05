"use client"

import { useEffect, useState } from "react"

interface ScriptedPhasesOptions {
  /**
   * How long each phase holds before the next one, in milliseconds. The
   * sequence has `delays.length + 1` phases: index 0 is the opening state,
   * and the last delay leads into the final one.
   */
  delays: readonly number[]
  /**
   * Caller-controlled kill switch, `false` under `prefers-reduced-motion`
   * or before the surface is on screen. When disabled the hook reports the
   * final phase immediately, so a reader who asked for no motion gets the
   * complete picture rather than an empty first frame.
   */
  enabled: boolean
}

/**
 * The phase a scripted sequence is in, for a surface that builds itself up in
 * a fixed order: a thread receiving its turns, a diff arriving line by line.
 *
 * It is deliberately one-shot. It runs forward once and stops on the last
 * phase. The hero's sequence ends on `Waiting for approval`, and a loop would
 * undo the site's central narrative beat every few seconds (spec 6.1).
 *
 * `enabled` flipping from `false` to `true` restarts from the opening state.
 * Flipping back reports the final phase without a re-render cascade, because
 * the value is derived rather than written.
 */
export function useScriptedPhases({ delays, enabled }: ScriptedPhasesOptions): number {
  const last = delays.length
  const [phase, setPhase] = useState(0)

  // Reset on the edge, during render, which is React's sanctioned way to
  // derive state from a prop change: no effect, no extra committed frame with
  // the previous run's phase still showing.
  const [wasEnabled, setWasEnabled] = useState(enabled)
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled)
    setPhase(0)
  }

  useEffect(() => {
    if (!enabled) return
    let index = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const advance = () => {
      if (index >= delays.length) return
      timer = setTimeout(() => {
        index += 1
        setPhase(index)
        advance()
      }, delays[index])
    }
    advance()
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
    // `delays` is a module constant at every call site. Its identity is
    // stable and its contents are what the sequence is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return enabled ? Math.min(phase, last) : last
}
