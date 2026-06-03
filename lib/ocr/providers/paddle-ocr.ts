/**
 * Paddle OCR provider — PP-OCRv5 via the `oar-ocr` Rust crate.
 *
 * Mirrors the `ocrs` provider's plumbing: dispatches to
 * `ocr_extract_native` with the `"paddle-ocr"` backend tag, which the
 * Rust side routes through the feature-gated `oar-ocr` + `ort` stack.
 * Strong CJK accuracy; the language hints in `OcrInput.languages` are
 * forwarded but the underlying model handles multilingual recognition
 * via the bundled dictionary regardless of the hint.
 */

import { normalizeImage } from "../image-prep"
import { OcrError } from "@/lib/ocr/errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
import {
  __setNativeOcrInvoker as setShared,
  type NativeOcrInvoker,
  type NativeOcrResult,
} from "./tesseract-native"

export interface PaddleOcrConfig {
  /** Override invoker — tests inject a mock here. */
  invoker?: NativeOcrInvoker
  /** Optional readiness override; default reads the module-level probe. */
  isReady?: () => boolean | Promise<boolean>
  /** Model variant hint — passed through to the backend via `options`. */
  model?: string
}

let invoker: NativeOcrInvoker | null = null
let readinessProbe: (() => boolean | Promise<boolean>) | null = null

export function __setPaddleOcrInvoker(impl: NativeOcrInvoker | null): void {
  invoker = impl
  if (impl) setShared(impl)
}

export function __setPaddleOcrReadiness(probe: (() => boolean | Promise<boolean>) | null): void {
  readinessProbe = probe
}

export function buildPaddleOcrProvider(): OcrProvider {
  return {
    id: "paddle-ocr",
    label: "PaddleOCR (local)",
    category: "local",
    shells: { browser: false, tauri: true, capacitor: false },
    credentialKeys: [],
    async extract(input, ctx) {
      return paddleOcrExtract(input, ctx)
    },
  }
}

export async function paddleOcrExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as PaddleOcrConfig
  const probe = config.isReady ?? readinessProbe
  if (probe) {
    const ready = await probe()
    if (!ready) {
      throw new OcrError(
        "unsupported_shell",
        "paddle-ocr",
        "PaddleOCR models are not installed — open Settings → OCR → PaddleOCR → Download model."
      )
    }
  }
  const invokeFn = config.invoker ?? invoker
  if (!invokeFn) {
    throw new OcrError(
      "unsupported_shell",
      "paddle-ocr",
      "PaddleOCR requires the Tauri desktop shell — the native command is not registered."
    )
  }
  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? ["zh-cn", "en"]).map((l) => l.toLowerCase())
  const start = Date.now()
  let payload: NativeOcrResult
  try {
    payload = await invokeFn({
      backend: "paddle-ocr",
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      languages,
      options: config.model ? { model: config.model } : undefined,
    })
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "paddle-ocr",
      err instanceof Error ? err.message : String(err),
      err
    )
  }
  const blocks: OcrBlock[] = (payload.blocks ?? []).map((b) => ({
    text: b.text,
    bbox: b.bbox,
    confidence: b.confidence,
    kind: "line" as const,
  }))
  return {
    providerId: "paddle-ocr",
    pages: [
      {
        pageNumber: 1,
        markdown: payload.text,
        text: payload.text,
        blocks,
        width: payload.width,
        height: payload.height,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages,
    durationMs: Date.now() - start,
    cached: false,
  }
}

export const paddleOcrProvider = buildPaddleOcrProvider()
