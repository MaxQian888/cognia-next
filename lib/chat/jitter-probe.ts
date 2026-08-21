/**
 * Reading-area stability probe (ADR-0138).
 *
 * The question "does the transcript jitter while a reply streams?" has one
 * answerable form: **does already-rendered content ever move backwards?**
 *
 * While a turn streams and the reader is parked at the foot, the list appends
 * below and pins the scroll to match. Done in one frame, a sentinel sitting at
 * the tail of the rendered content holds a constant viewport position and
 * everything above it travels upward monotonically. Done across two frames —
 * the browser paints the growth, and only the NEXT frame corrects the scroll —
 * the sentinel lurches down and snaps back. Same net displacement, opposite
 * experience. So the metric is not "how far did it move" (which drifts with
 * content length, font and viewport width, and would make a flaky gate) but
 * "how many times did it change direction", whose correct value is zero.
 *
 * {@link analyzeStability} is the pure half — feed it sampled positions from
 * anywhere (a Storybook probe, a Playwright trace, a hand-built array in a unit
 * test) and it reports the reversals. {@link createStabilityProbe} is the thin
 * rAF sampler the Storybook story drives; it is browser-only and does nothing
 * you could not do by hand.
 */

/** Movements at or below this many px are noise (sub-pixel layout, rounding). */
export const STABILITY_EPSILON_PX = 0.5

export interface StabilityReversal {
  /** Index into the sample array where the direction flipped. */
  frame: number
  /** Signed movement, px. Positive is downward on screen. */
  deltaPx: number
}

export interface StabilityReport {
  /** How many positions were sampled. */
  samples: number
  /** Direction changes beyond the epsilon. The gate is `reversals === 0`. */
  reversals: number
  /** Largest single movement that reversed direction, px. */
  maxReversalPx: number
  /** Every reversal, in order — enough to point at the offending frame. */
  detail: StabilityReversal[]
  /** Total travel from first sample to last, px. Diagnostic only. */
  netPx: number
}

/**
 * Count direction changes in a sequence of sampled positions.
 *
 * Movements within `epsilonPx` are ignored outright rather than folded into the
 * running direction: a genuine 40px-per-second drift must not be split into a
 * thousand "reversals" by sub-pixel rounding, and a stationary sentinel must not
 * acquire a direction it never had.
 */
export function analyzeStability(
  positions: readonly number[],
  epsilonPx: number = STABILITY_EPSILON_PX
): StabilityReport {
  const detail: StabilityReversal[] = []
  let direction = 0
  let maxReversalPx = 0

  for (let index = 1; index < positions.length; index++) {
    const deltaPx = positions[index]! - positions[index - 1]!
    if (Math.abs(deltaPx) <= epsilonPx) continue
    const next = deltaPx > 0 ? 1 : -1
    if (direction !== 0 && next !== direction) {
      detail.push({ frame: index, deltaPx })
      maxReversalPx = Math.max(maxReversalPx, Math.abs(deltaPx))
    }
    direction = next
  }

  return {
    samples: positions.length,
    reversals: detail.length,
    maxReversalPx,
    detail,
    netPx: positions.length > 1 ? positions[positions.length - 1]! - positions[0]! : 0,
  }
}

/** One line summarising a report, for a story's readout or a CI message. */
export function formatStabilityReport(report: StabilityReport): string {
  if (report.reversals === 0) {
    return `stable — ${report.samples} frames, ${report.netPx.toFixed(1)}px net travel`
  }
  const worst = report.maxReversalPx.toFixed(1)
  const frames = report.detail.map((entry) => entry.frame).join(", ")
  return `${report.reversals} reversal(s) over ${report.samples} frames, worst ${worst}px at frame ${frames}`
}

export interface StabilityProbe {
  /** Stop sampling and return what was collected. */
  stop: () => StabilityReport
}

export interface StabilityProbeOptions {
  /** Reads the tracked position each frame. Usually a `getBoundingClientRect().top`. */
  read: () => number
  /** Stop automatically after this many frames. Defaults to 600 (~10s at 60fps). */
  maxFrames?: number
  epsilonPx?: number
}

/**
 * Sample `read()` once per animation frame until stopped.
 *
 * Deliberately a plain rAF loop rather than a ResizeObserver or a
 * MutationObserver: the failure being measured IS a frame-timing one, so the
 * sampler has to run on the frame clock and nothing else.
 */
export function createStabilityProbe({
  read,
  maxFrames = 600,
  epsilonPx = STABILITY_EPSILON_PX,
}: StabilityProbeOptions): StabilityProbe {
  const positions: number[] = []
  let frame: number | null = null
  let running = true

  const tick = () => {
    if (!running) return
    positions.push(read())
    if (positions.length >= maxFrames) {
      running = false
      return
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  return {
    stop() {
      running = false
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      return analyzeStability(positions, epsilonPx)
    },
  }
}
