/**
 * Tesseract.js (WASM) OCR provider.
 *
 * Loads `tesseract.js` v7 lazily — only the first call inside a session pays
 * the wasm fetch + worker boot cost. Subsequent calls reuse the shared
 * worker registered in module scope.
 *
 * The provider intentionally exposes a `recognizer` factory so tests can
 * inject a mock without touching the real WASM binary, which jsdom can't
 * execute.
 */

import { normalizeImage } from "../image-prep"
import {
  OcrError,
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"

/**
 * Slim slice of tesseract.js's recognize() return shape. Only the bits we
 * actually consume are listed — full type lives in tesseract.js's d.ts.
 */
export interface TesseractRecognizeResult {
  data: {
    text: string
    confidence?: number
    paragraphs?: Array<{
      text: string
      confidence?: number
      bbox?: { x0?: number; y0?: number; x1?: number; y1?: number }
    }>
    lines?: Array<{
      text: string
      confidence?: number
      bbox?: { x0?: number; y0?: number; x1?: number; y1?: number }
    }>
    words?: Array<{
      text: string
      confidence?: number
      bbox?: { x0?: number; y0?: number; x1?: number; y1?: number }
    }>
  }
}

export interface TesseractRecognizer {
  recognize(
    image: Blob | Uint8Array | string,
    language: string,
    options?: Record<string, unknown>
  ): Promise<TesseractRecognizeResult>
  terminate?(): Promise<void>
}

export interface TesseractWasmConfig {
  /** Tesseract language list — defaults to ["eng"]. */
  languages?: string[]
  /** Path prefix served from `public/ocr/` (filled in by scripts/copy-ocr-assets.mjs). */
  workerPath?: string
  corePath?: string
  langPath?: string
  /** Optional override used by tests; in production, the real loader resolves it. */
  recognizer?: TesseractRecognizer
}

export type TesseractRecognizerFactory = (
  langs: string[],
  opts: Pick<TesseractWasmConfig, "workerPath" | "corePath" | "langPath">
) => Promise<TesseractRecognizer>

let cachedRecognizer: TesseractRecognizer | null = null
let cachedLangKey: string | null = null

/** Default factory dynamically imports tesseract.js. Skipped under jsdom in tests. */
export const defaultRecognizerFactory: TesseractRecognizerFactory = async (langs, opts) => {
  // The dynamic import is webpackIgnore'd so the package isn't bundled into
  // the static export — the WASM core is copied to `public/ocr/` by
  // scripts/copy-ocr-assets.mjs at build time.
  const moduleId = "tesseract.js"
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
    createWorker: (
      lang: string,
      oem?: number,
      options?: Record<string, unknown>
    ) => Promise<TesseractRecognizer>
  }
  const langKey = langs.join("+") || "eng"
  return mod.createWorker(langKey, undefined, {
    workerPath: opts.workerPath,
    corePath: opts.corePath,
    langPath: opts.langPath,
  })
}

let factory: TesseractRecognizerFactory = defaultRecognizerFactory

/** Test helper — swap in a mock factory. */
export function __setTesseractRecognizerFactory(next: TesseractRecognizerFactory | null): void {
  factory = next ?? defaultRecognizerFactory
  cachedRecognizer = null
  cachedLangKey = null
}

export function buildTesseractWasmProvider(): OcrProvider {
  return {
    id: "tesseract-wasm",
    label: "Tesseract (WASM)",
    category: "local",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    async extract(input, ctx) {
      return tesseractWasmExtract(input, ctx)
    },
  }
}

export async function tesseractWasmExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as TesseractWasmConfig
  const langs = (
    (input.languages ?? config.languages ?? ["eng"]).map((l) => mapLanguage(l)) as string[]
  ).filter((l) => l.length > 0)
  const langKey = langs.join("+") || "eng"
  const normalized = await normalizeImage(input.source)

  let recognizer: TesseractRecognizer
  if (config.recognizer) {
    recognizer = config.recognizer
  } else {
    if (cachedRecognizer && cachedLangKey === langKey) {
      recognizer = cachedRecognizer
    } else {
      try {
        recognizer = await factory(langs, {
          workerPath: config.workerPath,
          corePath: config.corePath,
          langPath: config.langPath,
        })
      } catch (err) {
        throw new OcrError(
          "provider_failed",
          "tesseract-wasm",
          err instanceof Error ? err.message : String(err),
          err
        )
      }
      cachedRecognizer = recognizer
      cachedLangKey = langKey
    }
  }

  const start = Date.now()
  let payload: TesseractRecognizeResult
  try {
    payload = await recognizer.recognize(normalized.bytes, langKey)
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "tesseract-wasm",
      err instanceof Error ? err.message : String(err),
      err
    )
  }

  const blocks: OcrBlock[] = (payload.data.paragraphs ?? []).map((p) => ({
    text: p.text,
    bbox: bboxFrom(p.bbox),
    confidence: typeof p.confidence === "number" ? p.confidence / 100 : undefined,
    kind: "paragraph",
  }))

  return {
    providerId: "tesseract-wasm",
    pages: [
      {
        pageNumber: 1,
        markdown: payload.data.text.trim(),
        text: payload.data.text.trim(),
        blocks,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages: langs,
    durationMs: Date.now() - start,
    cached: false,
  }
}

function bboxFrom(
  bbox: { x0?: number; y0?: number; x1?: number; y1?: number } | undefined
): OcrBlock["bbox"] | undefined {
  if (!bbox) return undefined
  const x0 = bbox.x0 ?? 0
  const y0 = bbox.y0 ?? 0
  const x1 = bbox.x1 ?? x0
  const y1 = bbox.y1 ?? y0
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** BCP-47 → Tesseract triplet mapping. Falls through unknown values. */
function mapLanguage(input: string): string {
  const lower = input.toLowerCase().split("-")[0]
  switch (lower) {
    case "en":
      return "eng"
    case "zh":
      return "chi_sim"
    case "ja":
      return "jpn"
    case "ko":
      return "kor"
    case "de":
      return "deu"
    case "fr":
      return "fra"
    case "es":
      return "spa"
    case "it":
      return "ita"
    case "pt":
      return "por"
    case "ru":
      return "rus"
    case "ar":
      return "ara"
    default:
      return lower
  }
}

export const tesseractWasmProvider = buildTesseractWasmProvider()
