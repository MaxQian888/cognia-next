/**
 * The footer's "working" word, cycling through {@link SPINNER_VERBS} while a turn
 * streams (the Claude Code touch). Mirrors {@link Mascot}: this component owns the
 * only timer — an interval that advances the verb — and is never asserted on its
 * animation. While the turn is being aborted the word is a static "stopping"; the
 * timer runs only during active streaming, so a settling turn costs no ticks.
 */
import React, { useEffect, useState } from "react"
import { Text } from "ink"

import { spinnerVerb } from "../format/spinner-verbs"
import type { TurnStatus } from "../state/types"

/** Verb rotation interval — slow enough to read each word. */
const VERB_MS = 1800

export function WorkingIndicator({ turnStatus }: { turnStatus: TurnStatus }) {
  const [tick, setTick] = useState(0)
  const streaming = turnStatus === "streaming"

  useEffect(() => {
    // Rotate only while actively streaming; aborting shows a static word and a
    // stale tick across that transition is harmless (the word is overridden).
    if (!streaming) return
    const id = setInterval(() => setTick((t) => t + 1), VERB_MS)
    return () => clearInterval(id)
  }, [streaming])

  return <Text>{turnStatus === "aborting" ? "stopping" : spinnerVerb(tick)}</Text>
}
