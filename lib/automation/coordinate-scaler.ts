/**
 * Maps Anthropic computer-use model coordinates back to physical screen
 * pixels when screenshot down-scaling is active (Settings → Automation →
 * Behavior). Mirrors the bidirectional scaling in Anthropic's
 * computer-use-demo (`scaling.py`): the model only ever sees the scaled
 * frame, so every coordinate it emits is in scaled space and must be
 * multiplied back up before dispatch.
 *
 * State is keyed by capture target (`sessionKey` / cua connection id /
 * "local") and updated on every screenshot that flows through
 * `anthropic-action-mapper.ts`. With scaling disabled the recorded source
 * dims equal the scaled dims and the math degenerates to identity.
 */

interface ScalerEntry {
  scaledWidth: number
  scaledHeight: number
  sourceWidth: number
  sourceHeight: number
}

const state = new Map<string, ScalerEntry>()

/**
 * Out-of-bounds tolerance in scaled pixels — models occasionally emit
 * coordinates a hair past the edge; those clamp instead of failing.
 */
const EDGE_TOLERANCE = 2

/** Record the dimensions of the latest screenshot for a capture target. */
export function recordScreenshotDims(
  targetKey: string,
  shot: { width: number; height: number; sourceWidth?: number; sourceHeight?: number }
): void {
  state.set(targetKey, {
    scaledWidth: shot.width,
    scaledHeight: shot.height,
    sourceWidth: shot.sourceWidth ?? shot.width,
    sourceHeight: shot.sourceHeight ?? shot.height,
  })
}

export type ScaleResult = { ok: true; x: number; y: number } | { ok: false; error: string }

/**
 * Translate a model-space coordinate into physical screen pixels.
 * Identity when no screenshot has been recorded for the target (the model
 * can't know scaled space before its first screenshot) or when no scaling
 * was applied. Rejects coordinates outside the screenshot the model saw —
 * a misplaced click is worse than a retried one.
 */
export function modelToScreen(targetKey: string, coordinate: [number, number]): ScaleResult {
  const entry = state.get(targetKey)
  const [mx, my] = coordinate
  if (!entry) return { ok: true, x: mx, y: my }
  const { scaledWidth, scaledHeight, sourceWidth, sourceHeight } = entry
  if (
    mx < -EDGE_TOLERANCE ||
    my < -EDGE_TOLERANCE ||
    mx > scaledWidth + EDGE_TOLERANCE ||
    my > scaledHeight + EDGE_TOLERANCE
  ) {
    return {
      ok: false,
      error: `coordinate [${mx}, ${my}] is out of bounds for the ${scaledWidth}x${scaledHeight} screenshot — take a fresh screenshot and retry`,
    }
  }
  const cx = Math.min(Math.max(mx, 0), scaledWidth)
  const cy = Math.min(Math.max(my, 0), scaledHeight)
  return {
    ok: true,
    x: Math.round((cx * sourceWidth) / scaledWidth),
    y: Math.round((cy * sourceHeight) / scaledHeight),
  }
}

/** Drop the recorded dims for one capture target (session close). */
export function clearScalerTarget(targetKey: string): void {
  state.delete(targetKey)
}

/** Test-only: clear all per-target state. */
export function resetScalerState(): void {
  state.clear()
}
