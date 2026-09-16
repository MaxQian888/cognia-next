/**
 * Poll the OS clipboard for image content so the composer can advertise the
 * paste-image shortcut exactly when it would do something.
 *
 * The probe is a cheap advertised-type check (`hasClipboardImage` in
 * `../clipboard-image`) — it inspects the pasteboard's type list instead of
 * decoding an image, so a two-second cadence costs one short-lived helper
 * process per tick and never writes a temp file. The interval is `unref`ed so
 * it can never hold the process open, only one probe runs at a time, and the
 * loop stops entirely while `active` is false (overlay open, non-chat phase)
 * or no probe was supplied.
 */
import { useEffect, useRef, useState } from "react"

/** Default poll cadence — frequent enough to feel live, cheap enough to idle. */
export const CLIPBOARD_IMAGE_POLL_MS = 2000

export function useClipboardImageMonitor(opts: {
  /** Async image check; `undefined` disables polling entirely. */
  probe?: () => Promise<boolean>
  /** Poll only while this holds (chat phase, no modal overlay open). */
  active?: boolean
  intervalMs?: number
}): boolean {
  const { probe, active = true, intervalMs = CLIPBOARD_IMAGE_POLL_MS } = opts
  const [ready, setReady] = useState(false)
  const probeRef = useRef(probe)
  useEffect(() => {
    probeRef.current = probe
  }, [probe])

  useEffect(() => {
    if (!active || !probeRef.current) return
    let cancelled = false
    let inflight = false
    const tick = () => {
      if (inflight || cancelled) return
      inflight = true
      void Promise.resolve(probeRef.current!())
        .catch(() => false)
        .then((result) => {
          inflight = false
          if (!cancelled) setReady(result === true)
        })
    }
    // Run once immediately so a clipboard that already holds an image shows
    // the hint without waiting a full interval.
    tick()
    const timer = setInterval(tick, intervalMs)
    // Node timers keep the loop alive by default — never let a hint do that.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, intervalMs])

  // Mask stale `ready` while inactive: the effect stops polling but the last
  // result is kept, so re-activation can flash one frame until the first tick.
  return active && ready
}
