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
import { OcrError } from "@/lib/ocr/errors"
import type { ImageFormat, Screenshot, ScreenshotOpts } from "./types"
import type { OcrInput, OcrResult } from "@/types/ocr"

function mimeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/png"
}

/**
 * Wrap a phase failure in a descriptive `OcrError` so the tool layer shows
 * the model "screen OCR failed at <phase>: <reason>" instead of a bare
 * provider/transport stack. Typed `OcrError`s pass through unchanged —
 * their code/provider already carry the diagnosis.
 */
function rethrowPhase(phase: "capture" | "extract", err: unknown): never {
  if (err instanceof OcrError) throw err
  const reason = err instanceof Error ? err.message : String(err)
  throw new OcrError(
    phase === "capture" ? "invalid_input" : "provider_failed",
    "ocr-screen",
    `screen OCR failed at ${phase}: ${reason}`,
    err
  )
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
  let shot: Pick<Screenshot, "bytes" | "format">
  try {
    shot = await deps.screenshot(args.opts ?? {}, args.ctx ?? { surface: "computerUse" })
  } catch (err) {
    rethrowPhase("capture", err)
  }
  const mimeType = mimeForFormat(shot.format)
  try {
    return await deps.extract(
      {
        source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${shot.bytes}`, mimeType },
        languages: args.languages,
      },
      deps.ocrDeps
    )
  } catch (err) {
    rethrowPhase("extract", err)
  }
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
