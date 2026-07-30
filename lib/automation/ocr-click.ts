/**
 * `find_text` / `click_text` — OCR-assisted screen interaction (ADR-0020 ⇄
 * ADR-0024 bridge). Capture the screen via the gated automation pipeline, run
 * it through OCR (which returns per-block bounding boxes), then either report
 * the matching blocks with screen-space coordinates (`findScreenText`) or click
 * the best match's center (`clickScreenText`).
 *
 * This bridges the pixel surface (Computer Use) with the OCR subsystem: the
 * model no longer has to eyeball a screenshot and guess pixel coordinates — it
 * names the on-screen text and we resolve the coordinate. Both capture and
 * click ride the same `CallContext` permission/consent/audit gate as every
 * other computer-use action.
 *
 * Coordinate mapping: OCR returns `bbox` in the captured image's pixel space.
 * We map it back to physical screen coordinates by (a) the OCR provider's own
 * rasterization dims (`OcrPage.width/height`) and (b) the Rust screenshot
 * downscale factor (`Screenshot.sourceWidth/Height`). The capture is the primary monitor — see the
 * single/primary-monitor caveat shared with `browser_embed_capture`.
 */

import { desktop, type CallContext } from "./client"
import { extract as defaultExtract, type ExtractDeps } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { OcrError } from "@/lib/ocr/errors"
import type { Point, Screenshot, ScreenshotOpts } from "./types"
import type { OcrInput, OcrResult } from "@/types/ocr"

/** One OCR block resolved to physical screen coordinates. */
export interface ScreenTextMatch {
  text: string
  /** Screen-space bounding box (physical px). */
  bbox: { x: number; y: number; width: number; height: number }
  /** Center of the box — pass straight to `desktop.click`. */
  center: Point
  /** Provider confidence (0..1) when available. */
  confidence?: number
}

export interface FindScreenTextResult {
  ok: true
  providerId: string
  /** Matches ranked best-first when a `query` was given; all blocks otherwise. */
  matches: ScreenTextMatch[]
  /** Physical capture dimensions, for context. */
  capture: { width: number; height: number }
}

export interface OcrClickDeps {
  screenshot: (opts: ScreenshotOpts, ctx: CallContext) => Promise<Screenshot>
  extract: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
  click: (point: Point, ctx: CallContext) => Promise<void>
  ocrDeps: ExtractDeps
}

export interface FindScreenTextArgs {
  /** Substring to locate (case-insensitive, whitespace-collapsed). Omit to list all blocks. */
  query?: string
  ctx?: CallContext
  languages?: string[]
  opts?: ScreenshotOpts
}

export interface ClickScreenTextArgs extends FindScreenTextArgs {
  query: string
  /** 1-based match to click when several blocks match (default 1). */
  occurrence?: number
  /** Mouse button + click count forwarded to `desktop.click`. */
  button?: "left" | "right" | "middle"
  doubleClick?: boolean
}

function mimeForFormat(format: Screenshot["format"]): string {
  return format === "jpeg" ? "image/jpeg" : "image/png"
}

/** Collapse whitespace + lowercase for forgiving substring matching. */
function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * Map the first OCR page's blocks into screen-space matches. `factor` accounts
 * for both provider-side rasterization and the Rust screenshot downscale.
 */
export function blocksToScreenMatches(result: OcrResult, shot: Screenshot): ScreenTextMatch[] {
  const page = result.pages[0]
  if (!page) return []
  const pageW = page.width || shot.width
  const pageH = page.height || shot.height
  const fx = (shot.sourceWidth ?? shot.width) / (pageW || 1)
  const fy = (shot.sourceHeight ?? shot.height) / (pageH || 1)
  const out: ScreenTextMatch[] = []
  for (const block of page.blocks ?? []) {
    if (!block.bbox) continue
    const x = block.bbox.x * fx
    const y = block.bbox.y * fy
    const width = block.bbox.width * fx
    const height = block.bbox.height * fy
    out.push({
      text: block.text,
      bbox: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      },
      center: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
      confidence: block.confidence,
    })
  }
  return out
}

/**
 * Rank matches for `query`: exact > prefix > substring, then by confidence,
 * then reading order (top-to-bottom, left-to-right). Non-matching blocks drop.
 */
export function rankMatches(blocks: ScreenTextMatch[], query: string): ScreenTextMatch[] {
  const q = norm(query)
  if (!q) return blocks
  const scored: Array<{ block: ScreenTextMatch; score: number }> = []
  for (const block of blocks) {
    const t = norm(block.text)
    let score = -1
    if (t === q) score = 3
    else if (t.startsWith(q)) score = 2
    else if (t.includes(q)) score = 1
    if (score < 0) continue
    scored.push({ block, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.block.confidence ?? 0) - (a.block.confidence ?? 0) ||
      a.block.center.y - b.block.center.y ||
      a.block.center.x - b.block.center.x
  )
  return scored.map((s) => s.block)
}

/** DI core — capture, OCR, map (and rank when a query is given). */
export async function findScreenTextWith(
  deps: OcrClickDeps,
  args: FindScreenTextArgs = {}
): Promise<FindScreenTextResult> {
  const ctx = args.ctx ?? { surface: "computerUse" as const }
  const shot = await deps.screenshot(args.opts ?? {}, ctx)
  const mimeType = mimeForFormat(shot.format)
  const result = await deps.extract(
    {
      source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${shot.bytes}`, mimeType },
      languages: args.languages,
    },
    deps.ocrDeps
  )
  const all = blocksToScreenMatches(result, shot)
  if (all.length === 0) {
    throw new OcrError(
      "provider_failed",
      "ocr-click",
      "the OCR provider returned no block geometry — pick a provider with bounding boxes (e.g. tesseract / windows-ocr) under Settings → OCR to use find_text/click_text"
    )
  }
  const matches = args.query ? rankMatches(all, args.query) : all
  return {
    ok: true,
    providerId: result.providerId,
    matches,
    capture: { width: shot.width, height: shot.height },
  }
}

/** DI core — find the Nth match for `query` and click its center. */
export async function clickScreenTextWith(
  deps: OcrClickDeps,
  args: ClickScreenTextArgs
): Promise<{ ok: true; clicked: ScreenTextMatch }> {
  const ctx = args.ctx ?? { surface: "computerUse" as const }
  const found = await findScreenTextWith(deps, {
    query: args.query,
    ctx,
    languages: args.languages,
    opts: args.opts,
  })
  const index = Math.max(1, Math.floor(args.occurrence ?? 1)) - 1
  const target = found.matches[index]
  if (!target) {
    throw new OcrError(
      "invalid_input",
      "ocr-click",
      `no on-screen text ${args.occurrence && args.occurrence > 1 ? `#${args.occurrence} ` : ""}matched ${JSON.stringify(args.query)} (${found.matches.length} match${found.matches.length === 1 ? "" : "es"} found)`
    )
  }
  // Stamp the resolved coordinate into the CallContext so the per-action policy
  // (ADR-0028 / T5 `clickX`/`clickY`) and audit can see where the click landed.
  await deps.click(target.center, { ...ctx, clickX: target.center.x, clickY: target.center.y })
  return { ok: true, clicked: target }
}

const productionDeps = (): OcrClickDeps => ({
  screenshot: (opts, ctx) => desktop.screenshot(opts, ctx),
  extract: defaultExtract,
  click: (point, ctx) => desktop.click({ kind: "point", x: point.x, y: point.y }, {}, ctx),
  ocrDeps: buildOcrDeps(),
})

/** Production entry: real gated screenshot + keyring-backed OCR + gated click. */
export function findScreenText(args: FindScreenTextArgs = {}): Promise<FindScreenTextResult> {
  return findScreenTextWith(productionDeps(), args)
}

export function clickScreenText(
  args: ClickScreenTextArgs
): Promise<{ ok: true; clicked: ScreenTextMatch }> {
  return clickScreenTextWith(
    {
      ...productionDeps(),
      // Honor per-call button/double via desktop.click opts.
      click: (point, ctx) =>
        desktop.click(
          { kind: "point", x: point.x, y: point.y },
          { button: args.button, double: args.doubleClick },
          ctx
        ),
    },
    args
  )
}
