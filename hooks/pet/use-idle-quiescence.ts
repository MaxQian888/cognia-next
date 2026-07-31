// Thin hook around the pure `shouldQuiesce` policy: returns true once the pet
// has sat in plain idle (no one-shot) for the quiescence delay, so the SVG skin
// can stop its breathing loop. Any state / one-shot change resets it and motion
// resumes. The boolean only ever flips true from an async timer (never a sync
// set-state in the effect body), and back to false by re-keying the effect.

"use client"

import { useEffect, useState } from "react"
import type { PetOneShot, PetVisualState } from "@/types/pet"
import { quiescenceDelay } from "@/lib/pet/animation/idle-quiescence"

export function useIdleQuiescence(
  state: PetVisualState,
  oneShot: PetOneShot | null,
  lowPower: boolean
): boolean {
  // Keyed by the inputs: each change re-mounts the effect, which starts a fresh
  // timer. The state defaults false on every key change via the functional
  // updater inside the timer only, so motion is live until the timer fires.
  const [quiescentKey, setQuiescentKey] = useState<string | null>(null)

  const key = `${state}|${oneShot ?? "none"}|${lowPower}`

  useEffect(() => {
    if (state !== "idle" || oneShot !== null) return
    const id = setTimeout(() => setQuiescentKey(key), quiescenceDelay(lowPower))
    return () => clearTimeout(id)
  }, [state, oneShot, lowPower, key])

  return quiescentKey === key && state === "idle" && oneShot === null
}
