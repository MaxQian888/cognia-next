/**
 * Paced reveal for streamed assistant text — a gentle "typing" cadence that
 * smooths bursty model output into a steady stream and snaps each cut to a word
 * or punctuation boundary so text never appears mid-word. Mirrors OpenCode's
 * `createPacedValue`: reveal at ~24ms, growing the chunk as the remaining text
 * shrinks (so a long backlog catches up quickly), and idle once caught up.
 *
 * The reveal is keyed by a TURN epoch, not by the text alone. Holding only a
 * character count meant a shorter second turn inherited the previous turn's
 * count and appeared whole instantly — the animation silently skipped exactly
 * the turns where it was most visible. The epoch resets it; a target that is no
 * longer an extension of what was already shown resets it too, which covers a
 * stream that was rewritten in place (an abort/retry) without needing the caller
 * to notice.
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
 * Should the reveal restart rather than continue?
 *
 * A stream only ever APPENDS, so a target that does not extend what was shown is
 * a different stream — a new turn whose epoch has not reached us yet, or an
 * in-place rewrite. Continuing there would show a prefix of the new text at the
 * old text's offset, which reads as corruption. Exported for direct testing.
 */
export function shouldResetReveal(previous: string, next: string): boolean {
  if (next.length < previous.length) return true
  return !next.startsWith(previous)
}

export interface PacedRevealOptions {
  /** Milliseconds between reveal ticks. */
  paceMs?: number
  /**
   * Turn identity. Any change restarts the reveal from zero. Omit on surfaces
   * that render one stream for their whole lifetime.
   */
  epoch?: number
}

/**
 * Reveal `target` progressively while `enabled`; otherwise return it whole. The
 * returned string is always a prefix of `target`. As `target` grows the reveal
 * keeps pace; once it catches up the internal timer idles until more text
 * arrives.
 */
export function usePacedReveal(
  target: string,
  enabled: boolean,
  options: PacedRevealOptions | number = {}
): string {
  // Back-compat: the third argument used to be `paceMs`.
  const { paceMs = 24, epoch } = typeof options === "number" ? { paceMs: options } : options
  const [shown, setShown] = useState(() => (enabled ? 0 : target.length))
  // Previous inputs held as STATE, not refs, so the comparison below is React's
  // documented "adjust state while rendering" pattern rather than a ref read
  // during render.
  const [prevTarget, setPrevTarget] = useState(target)
  const [prevEpoch, setPrevEpoch] = useState(epoch)

  // Reset DURING render (not in an effect) so the very first frame of a new turn
  // already shows the new turn's prefix. Doing it in an effect would paint one
  // frame of the previous turn's reveal length against the new text.
  if (target !== prevTarget || epoch !== prevEpoch) {
    const restart = epoch !== prevEpoch || shouldResetReveal(prevTarget, target)
    setPrevTarget(target)
    setPrevEpoch(epoch)
    if (enabled && restart && shown !== 0) setShown(0)
  }

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
