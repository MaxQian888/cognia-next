/**
 * Tesseract (native) OCR provider — delegates to a Tauri command which calls
 * `tesseract-rs` under the hood. Available on the Tauri shell only.
 *
 * The Rust side ships in `src-tauri/src/ocr/backend/tesseract.rs`; the
 * IPC contract is the `ocr_extract_native` command with a payload that names
 * which backend to use.
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

/** Shape the Rust side returns; mirrors `NativeOcrResult` in src-tauri. */
export interface NativeOcrResult {
  text: string
  blocks: Array<{
    text: string
    bbox?: { x: number; y: number; width: number; height: number }
    confidence?: number
  }>
  width?: number
  height?: number
}

export type NativeOcrInvoker = (payload: NativeOcrInvokePayload) => Promise<NativeOcrResult>

export interface NativeOcrInvokePayload {
  backend: "tesseract" | "windows-media-ocr" | "apple-vision" | "ocrs" | "paddle-ocr"
  bytes: Uint8Array
  mimeType: string
  languages: string[]
  options?: Record<string, unknown>
}

export interface TesseractNativeConfig {
  /** Override invoker — used by tests to short-circuit Tauri. */
  invoker?: NativeOcrInvoker
  languages?: string[]
}

let defaultInvoker: NativeOcrInvoker | null = null

/** Test helper / app boot — registers the real Tauri invoker. */
export function __setNativeOcrInvoker(impl: NativeOcrInvoker | null): void {
  defaultInvoker = impl
}

export function buildTesseractNativeProvider(): OcrProvider {
  return {
    id: "tesseract-native",
    label: "Tesseract (native)",
    category: "local",
    shells: { browser: false, tauri: true, capacitor: false },
    credentialKeys: [],
    async extract(input, ctx) {
      return tesseractNativeExtract(input, ctx)
    },
  }
}

export async function tesseractNativeExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as TesseractNativeConfig
  const invoker = config.invoker ?? defaultInvoker
  if (!invoker) {
    throw new OcrError(
      "unsupported_shell",
      "tesseract-native",
      "Tesseract (native) requires the Tauri desktop shell."
    )
  }
  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? config.languages ?? ["en"]).map((l) => l.toLowerCase())

  const start = Date.now()
  let payload: NativeOcrResult
  try {
    payload = await invoker({
      backend: "tesseract",
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      languages,
    })
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "tesseract-native",
      err instanceof Error ? err.message : String(err),
      err
    )
  }
  const blocks: OcrBlock[] = (payload.blocks ?? []).map((b) => ({
    text: b.text,
    bbox: b.bbox,
    confidence: b.confidence,
    kind: "paragraph",
  }))
  return {
    providerId: "tesseract-native",
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

export const tesseractNativeProvider = buildTesseractNativeProvider()
