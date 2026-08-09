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
import { OcrError } from "../errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import {
  __setNativeOcrInvoker as setShared,
  mapNativeInvokeError,
  type NativeOcrInvoker,
  type NativeOcrResult,
} from "./tesseract-native"

export interface PaddleOcrConfig {
  /** PP-OCRv6 asset tier. Small is the product default; Tiny minimizes download size. */
  model?: "v6-small" | "v6-tiny"
  /** Override invoker — tests inject a mock here. */
  invoker?: NativeOcrInvoker
  /** Optional readiness override; default reads the module-level probe. */
  isReady?: (variant: NonNullable<PaddleOcrConfig["model"]>) => boolean | Promise<boolean>
}

let invoker: NativeOcrInvoker | null = null
let readinessProbe:
  ((variant: NonNullable<PaddleOcrConfig["model"]>) => boolean | Promise<boolean>) | null = null

export function __setPaddleOcrInvoker(impl: NativeOcrInvoker | null): void {
  invoker = impl
  if (impl) setShared(impl)
}

export function __setPaddleOcrReadiness(
  probe: ((variant: NonNullable<PaddleOcrConfig["model"]>) => boolean | Promise<boolean>) | null
): void {
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
  const model = config.model ?? "v6-small"
  const probe = config.isReady ?? readinessProbe
  if (probe) {
    const ready = await probe(model)
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
      modelVariant: model,
    })
  } catch (err) {
    throw mapNativeInvokeError("paddle-ocr", "paddle-ocr", err)
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
