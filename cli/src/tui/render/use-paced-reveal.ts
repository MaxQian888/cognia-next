/**
 * Paced reveal for streamed assistant text — a gentle "typing" cadence that
 * smooths bursty model output into a steady stream and snaps each cut to a word
 * or punctuation boundary so text never appears mid-word. Mirrors OpenCode's
 * `createPacedValue`: reveal at ~24ms, growing the chunk as the remaining text
 * shrinks (so a long backlog catches up quickly), and idle once caught up.
 *
 * When disabled (non-interactive terminal, CI, tests, or opt-out) it returns the
 * full target immediately, so non-streaming surfaces are unaffected.
 */
import { useEffect, useState } from "react"

/** Characters a reveal may stop just after — whitespace and sentence/clause
 * punctuation — so a word is never split mid-token. */
const BOUNDARY = /[\s.,!?;:)\]}…—–]/

/**
 * Advance `n` forward to just past the next word/punctuation boundary in `text`,
 * looking ahead at most `lookahead` chars. If none is found within the window the
 * original `n` is returned (a long unbroken token reveals atomically on the next
 * tick). Exported for direct testing.
 */
export function snapForward(text: string, n: number, lookahead = 8): number {
  if (n >= text.length) return text.length
  const limit = Math.min(text.length, n + lookahead)
  for (let i = n; i < limit; i++) {
    if (BOUNDARY.test(text[i])) return i + 1
  }
  return n
}

/**
 * Reveal `target` progressively while `enabled`; otherwise return it whole. The
 * returned string is always a prefix of `target`. As `target` grows the reveal
 * keeps pace; once it catches up the internal timer idles until more text
 * arrives.
 */
export function usePacedReveal(target: string, enabled: boolean, paceMs = 24): string {
  const [shown, setShown] = useState(() => (enabled ? 0 : target.length))

  useEffect(() => {
    // When disabled the render below returns the whole target, so there's
    // nothing to animate (and no state to reset). Once caught up, hold the timer
    // until `target` (an effect dep) grows again. The interval closes over the
    // current `target` directly — the effect re-runs whenever it changes.
    if (!enabled || shown >= target.length) return
    const id = setInterval(() => {
      setShown((prev) => {
        if (prev >= target.length) return prev
        // Bigger steps as the backlog grows, so a fast burst doesn't lag visibly.
        const step = Math.max(1, Math.ceil((target.length - prev) / 16))
        return snapForward(target, Math.min(target.length, prev + step))
      })
    }, paceMs)
    return () => clearInterval(id)
  }, [enabled, target, paceMs, shown])

  if (!enabled) return target
  return target.slice(0, Math.min(shown, target.length))
}
