/**
 * `ocrScreen` — read the screen as text (ADR-0024 / Step 7).
 *
 * Renderer-only composition: capture a screenshot via the existing automation
 * client, then run the captured bytes through the OCR `extract()` pipeline. No
 * new Rust command — `desktop.screenshot` already returns base64 bytes, so the
 * screen-capture half stays behind the existing automation permission gate
 * (surface/tier), while OCR runs in the renderer.
 *
 * Exposed to the agent through the OCR tool's `source: "screen"` mode
 * (`plugins/ocr`); also callable directly by computer-use flows that want a
 * text view of the screen without round-tripping a screenshot to a vision
 * model.
 */

import { desktop, type CallContext } from "./client"
import { extract as defaultExtract, type ExtractDeps } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import type { ImageFormat, Screenshot, ScreenshotOpts } from "./types"
import type { OcrInput, OcrResult } from "@/types/ocr"

function mimeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/png"
}

export interface OcrScreenDeps {
  screenshot: (
    opts: ScreenshotOpts,
    ctx: CallContext
  ) => Promise<Pick<Screenshot, "bytes" | "format">>
  extract: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
  ocrDeps: ExtractDeps
}

/** DI core — capture then OCR. */
export async function ocrScreenWith(
  deps: OcrScreenDeps,
  args: { opts?: ScreenshotOpts; ctx?: CallContext; languages?: string[] } = {}
): Promise<OcrResult> {
  const shot = await deps.screenshot(args.opts ?? {}, args.ctx ?? { surface: "computerUse" })
  const mimeType = mimeForFormat(shot.format)
  return deps.extract(
    {
      source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${shot.bytes}`, mimeType },
      languages: args.languages,
    },
    deps.ocrDeps
  )
}

/** Production entry: real screenshot + keyring-backed OCR deps. */
export async function ocrScreen(
  args: {
    opts?: ScreenshotOpts
    ctx?: CallContext
    languages?: string[]
  } = {}
): Promise<OcrResult> {
  return ocrScreenWith(
    {
      screenshot: (opts, ctx) => desktop.screenshot(opts, ctx),
      extract: defaultExtract,
      ocrDeps: buildOcrDeps(),
    },
    args
  )
}
