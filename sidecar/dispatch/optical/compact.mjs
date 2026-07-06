// Optical compaction orchestration (ADR-0063): turn the compaction `middle`
// into an optical-archive message, or return null to fall back to text summary.
//
// Kept out of `ai-sdk.mjs` so it is testable in isolation — the only I/O is the
// injected `transcribe` (a one-shot vision read-back). The decision funnel is
// conservative: coverage gate → budget/overflow gate → worthwhile gate →
// round-trip readability gate. Any gate that fails returns null, and the caller
// summarizes the same `middle` as text instead, so context is never dropped to
// an unreadable image.

import { normalizeForOptical } from "./normalize.mjs"
import { planOpticalFrames } from "./layout.mjs"
import { renderSnapcompactPng } from "./render.mjs"
import { checkReadability } from "./readability.mjs"
import { makeOpticalMessage } from "../compaction.mjs"

function stripUndefined(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

/**
 * @param {{
 *   middle: Array<{role:string, content:any}>,
 *   modelId?: string,
 *   version: number,
 *   options?: object,
 *   transcribe?: (dataUrl:string) => Promise<string>,
 *   log?: (level:string, msg:string) => void,
 * }} p
 * @returns {Promise<{ message:object, meta:object } | null>}
 */
export async function buildOpticalCompaction({
  middle,
  modelId,
  version,
  options = {},
  transcribe,
  log,
}) {
  const {
    size = 1024,
    font,
    variant,
    cellWidth,
    cellHeight,
    columns,
    lineRepeat,
    maxFrames = 4,
    minCoverage = 0.7,
    minSavings = 0.15,
    verify = true,
    readabilityThreshold = 0.6,
  } = options
  const note = (level, msg) => log?.(level, `optical-compaction: ${msg}`)

  const norm = normalizeForOptical(middle, { fontName: font ?? "8x8", columns: columns ?? 1 })
  if (norm.charCount === 0) {
    note("info", "middle has no renderable text, falling back")
    return null
  }
  if (norm.coverage < minCoverage) {
    note("info", `coverage ${norm.coverage.toFixed(2)} < ${minCoverage}, falling back`)
    return null
  }

  const overrides = stripUndefined({ font, variant, cellWidth, cellHeight, columns, lineRepeat })
  const plan = planOpticalFrames({
    text: norm.text,
    modelId,
    size,
    shape: Object.keys(overrides).length ? overrides : undefined,
    maxFrames,
    minSavings,
  })
  if (plan.frames.length === 0) return null
  if (plan.overflow) {
    note("info", `${norm.charCount} chars overflow ${maxFrames} frames, falling back`)
    return null
  }
  if (!plan.worthwhile) {
    note(
      "info",
      `image ${plan.estImageTokens}t not below text ${plan.estTextTokens}t, falling back`
    )
    return null
  }

  const rendered = plan.frames.map((chunk) => renderSnapcompactPng(chunk, { size, ...plan.shape }))

  // Round-trip verify the first (representative) frame — one extra vision call.
  let readability
  if (verify && typeof transcribe === "function") {
    try {
      const back = await transcribe(rendered[0].dataUrl)
      const check = checkReadability(plan.frames[0], back, readabilityThreshold)
      readability = check.score
      if (!check.ok) {
        note(
          "info",
          `readability ${check.score.toFixed(2)} < ${readabilityThreshold}, falling back`
        )
        return null
      }
    } catch (err) {
      note("warn", `verify failed (${err?.message ?? err}), falling back`)
      return null
    }
  }

  const imageParts = rendered.map((f) => ({
    type: "image",
    image: f.dataUrl,
    mediaType: "image/png",
  }))
  const message = makeOpticalMessage(
    imageParts,
    { messageCount: middle.length, frameCount: rendered.length },
    version
  )
  const meta = {
    frameCount: rendered.length,
    size,
    shape: plan.shape,
    coverage: norm.coverage,
    charCount: norm.charCount,
    estImageTokens: plan.estImageTokens,
    estTextTokens: plan.estTextTokens,
    ...(readability != null ? { readability } : {}),
    byteLength: rendered.reduce((n, f) => n + f.byteLength, 0),
    frames: rendered.map((f) => ({ base64: f.base64, width: f.width, height: f.height })),
  }
  return { message, meta }
}
