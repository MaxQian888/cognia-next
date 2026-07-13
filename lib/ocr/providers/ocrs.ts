/**
 * ocrs OCR provider — pure-Rust cross-platform local engine.
 *
 * Delegates to the `ocr_extract_native` Tauri command with the `"ocrs"`
 * backend tag; the Rust side links the `ocrs` + `rten` crates behind the
 * `ocr-ocrs` Cargo feature. Models live in `<app_data>/cognia/ocr/ocrs/`
 * and are downloaded on first use via `ocr_download_model` — the
 * auto-router consults `readinessProbe()` to skip this provider when the
 * model files aren't present yet.
 *
 * Available on the Tauri shell only (the Rust side isn't reachable from
 * the browser export or the Capacitor wrapper).
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
  mapNativeInvokeError,
  type NativeOcrInvoker,
  type NativeOcrResult,
} from "./tesseract-native"

export interface OcrsConfig {
  /** Override the invoker — used by tests to short-circuit Tauri. */
  invoker?: NativeOcrInvoker
  /** Optional readiness override; default reads the module-level probe. */
  isReady?: () => boolean | Promise<boolean>
}

let invoker: NativeOcrInvoker | null = null
let readinessProbe: (() => boolean | Promise<boolean>) | null = null

/**
 * Test helper / app boot — register the real Tauri invoker. Mirrors the
 * shared native-OCR invoker so other providers (`tesseract-native`,
 * `windows-media-ocr`, `apple-vision`) keep routing through the same
 * command without separate plumbing.
 */
export function __setOcrsInvoker(impl: NativeOcrInvoker | null): void {
  invoker = impl
  if (impl) setShared(impl)
}

/** Test helper — swap in / out the readiness probe. */
export function __setOcrsReadiness(probe: (() => boolean | Promise<boolean>) | null): void {
  readinessProbe = probe
}

export function buildOcrsProvider(): OcrProvider {
  return {
    id: "ocrs",
    label: "ocrs (local)",
    category: "local",
    shells: { browser: false, tauri: true, capacitor: false },
    credentialKeys: [],
    async extract(input, ctx) {
      return ocrsExtract(input, ctx)
    },
  }
}

export async function ocrsExtract(input: OcrInput, ctx: OcrProviderContext): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as OcrsConfig
  const probe = config.isReady ?? readinessProbe
  if (probe) {
    const ready = await probe()
    if (!ready) {
      throw new OcrError(
        "unsupported_shell",
        "ocrs",
        "ocrs models are not installed — open Settings → OCR → ocrs → Download model."
      )
    }
  }
  const invokeFn = config.invoker ?? invoker
  if (!invokeFn) {
    throw new OcrError(
      "unsupported_shell",
      "ocrs",
      "ocrs requires the Tauri desktop shell — the native command is not registered."
    )
  }
  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? ["en"]).map((l) => l.toLowerCase())

  const start = Date.now()
  let payload: NativeOcrResult
  try {
    payload = await invokeFn({
      backend: "ocrs",
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      languages,
    })
  } catch (err) {
    throw mapNativeInvokeError("ocrs", "ocrs", err)
  }
  const blocks: OcrBlock[] = (payload.blocks ?? []).map((b) => ({
    text: b.text,
    bbox: b.bbox,
    confidence: b.confidence,
    kind: "line" as const,
  }))
  return {
    providerId: "ocrs",
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

export const ocrsProvider = buildOcrsProvider()
