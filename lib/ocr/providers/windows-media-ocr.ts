/**
 * Windows.Media.Ocr provider — delegates to a Tauri command which calls the
 * `winocr` Rust crate. Only available when the Tauri app runs inside an MSIX
 * package (winocr requires package identity).
 *
 * Availability detection lives in `crates/cognia-ocr/src/msix.rs`; the frontend
 * caches the readiness flag at app boot and re-uses it here.
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

export interface WindowsMediaOcrConfig {
  invoker?: NativeOcrInvoker
  /** Override readiness probe — tests use this to flip "MSIX-available" on/off. */
  isReady?: () => boolean | Promise<boolean>
}

let readinessProbe: (() => boolean | Promise<boolean>) | null = null
let invoker: NativeOcrInvoker | null = null

/** Test helper / app boot — register the real Tauri invoker. */
export function __setWindowsMediaOcrInvoker(impl: NativeOcrInvoker | null): void {
  invoker = impl
  // Keep the shared native-OCR invoker in sync so other providers (tesseract-
  // native / apple-vision) can route through the same Tauri command.
  if (impl) setShared(impl)
}

/** Test helper — swap in / out the readiness probe. */
export function __setWindowsMediaOcrReadiness(
  probe: (() => boolean | Promise<boolean>) | null
): void {
  readinessProbe = probe
}

export function buildWindowsMediaOcrProvider(): OcrProvider {
  return {
    id: "windows-media-ocr",
    label: "Windows.Media.Ocr",
    category: "local",
    shells: { browser: false, tauri: true, capacitor: false },
    credentialKeys: [],
    async extract(input, ctx) {
      return windowsMediaOcrExtract(input, ctx)
    },
  }
}

export async function windowsMediaOcrExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as WindowsMediaOcrConfig
  const probe = config.isReady ?? readinessProbe
  if (probe) {
    const ready = await probe()
    if (!ready) {
      throw new OcrError(
        "unsupported_shell",
        "windows-media-ocr",
        "Windows OCR requires the MSIX build — package identity is not available."
      )
    }
  }
  const invokeFn = config.invoker ?? invoker
  if (!invokeFn) {
    throw new OcrError(
      "unsupported_shell",
      "windows-media-ocr",
      "Windows OCR Tauri command is not registered."
    )
  }
  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  let payload: NativeOcrResult
  try {
    payload = await invokeFn({
      backend: "windows-media-ocr",
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      languages: (input.languages ?? ["en"]).map((l) => l.toLowerCase()),
    })
  } catch (err) {
    throw mapNativeInvokeError("windows-media-ocr", "windows-media-ocr", err)
  }
  const blocks: OcrBlock[] = (payload.blocks ?? []).map((b) => ({
    text: b.text,
    bbox: b.bbox,
    confidence: b.confidence,
    kind: "paragraph",
  }))
  return {
    providerId: "windows-media-ocr",
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
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

export const windowsMediaOcrProvider = buildWindowsMediaOcrProvider()
