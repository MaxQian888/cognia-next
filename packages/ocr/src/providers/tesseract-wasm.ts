/**
 * Tesseract.js (WASM) OCR provider.
 *
 * Loads `tesseract.js` v7 lazily — only the first call inside a session pays
 * the wasm fetch + worker boot cost. Subsequent calls reuse the shared
 * worker registered in module scope.
 *
 * Offline assets: `scripts/build/copy-ocr-assets.mjs` (wired into
 * `predev`/`prebuild`) copies `worker.min.js` and the tesseract.js-core
 * `-lstm` wasm bundles into `public/ocr/`, and the provider defaults
 * `workerPath`/`corePath` to those local files so no CDN access is needed in
 * any shell. `langPath` intentionally keeps tesseract.js's CDN default:
 * traineddata files are large and per-language, so bundling them all offline
 * is a user settings choice — a local mirror can be configured via
 * `config.langPath`.
 *
 * The provider intentionally exposes a `recognizer` factory so tests can
 * inject a mock without touching the real WASM binary, which jsdom can't
 * execute.
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

/** Local assets copied by scripts/build/copy-ocr-assets.mjs. */
const DEFAULT_WORKER_PATH = "/ocr/worker.min.js"
const DEFAULT_CORE_PATH = "/ocr/core"

export interface TesseractBbox {
  x0?: number
  y0?: number
  x1?: number
  y1?: number
}

/**
 * Slim slice of tesseract.js v7's recognize() return shape (`data` is the
 * `Page` type in tesseract.js's d.ts). Since v6, block/paragraph structures
 * are only populated when requested via the `output` argument of
 * recognize() — `data.blocks` is `null` otherwise.
 */
export interface TesseractRecognizeResult {
  data: {
    text: string
    confidence?: number
    blocks?: Array<{
      text: string
      confidence?: number
      bbox?: TesseractBbox
      paragraphs?: Array<{
        text: string
        confidence?: number
        bbox?: TesseractBbox
      }>
    }> | null
  }
}

/** Requested output formats — second/third args of worker.recognize(). */
export interface TesseractOutputFormats {
  text?: boolean
  blocks?: boolean
}

export interface TesseractRecognizer {
  recognize(
    image: Blob | Uint8Array | string,
    options?: Record<string, unknown>,
    output?: TesseractOutputFormats
  ): Promise<TesseractRecognizeResult>
  terminate?(): Promise<void>
}

export interface TesseractWasmConfig {
  /** Tesseract language list — defaults to ["eng"]. */
  languages?: string[]
  /** Path overrides; default to the local copies under `public/ocr/`. */
  workerPath?: string
  corePath?: string
  /** Traineddata directory — defaults to tesseract.js's CDN (see header). */
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
  // Lazy dynamic import — the tesseract.js JS glue only enters the chunk that
  // actually runs OCR, and the multi-MB wasm cores are never bundled: the
  // worker fetches them at runtime from `corePath` (local `public/ocr/`).
  const mod = await import("tesseract.js")
  // createWorker(langs, oem, options): language is fixed at worker creation,
  // NOT passed to recognize(). Default oem (LSTM_ONLY) matches the `-lstm`
  // cores copied by scripts/build/copy-ocr-assets.mjs.
  const worker = await mod.createWorker(langs.length > 0 ? langs : ["eng"], undefined, {
    workerPath: opts.workerPath ?? DEFAULT_WORKER_PATH,
    corePath: opts.corePath ?? DEFAULT_CORE_PATH,
    // Keep tesseract.js's CDN default for traineddata unless configured —
    // full offline language packs are a settings choice (see file header).
    ...(opts.langPath ? { langPath: opts.langPath } : {}),
  })
  return worker as unknown as TesseractRecognizer
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

  // tesseract.js's browser worker takes Blob/File/canvas/URL inputs — raw
  // Uint8Array is only supported on the node path, so wrap in a Blob.
  const image: Blob | Uint8Array =
    typeof Blob !== "undefined"
      ? new Blob([normalized.bytes as BlobPart], { type: normalized.mimeType })
      : normalized.bytes

  const start = Date.now()
  let payload: TesseractRecognizeResult
  try {
    // recognize(image, options, output): since v6 the block/paragraph tree is
    // opt-in via the `output` argument — without `blocks: true`, data.blocks
    // is null and we'd always return zero blocks.
    payload = await recognizer.recognize(image, {}, { text: true, blocks: true })
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "tesseract-wasm",
      err instanceof Error ? err.message : String(err),
      err
    )
  }

  const blocks: OcrBlock[] = []
  for (const block of payload.data.blocks ?? []) {
    const paragraphs = block.paragraphs ?? []
    if (paragraphs.length === 0) {
      // Degenerate block without a paragraph tree — surface it as one block.
      blocks.push({
        text: block.text,
        bbox: bboxFrom(block.bbox),
        confidence: normalizeConfidence(block.confidence),
        kind: "paragraph",
      })
      continue
    }
    for (const p of paragraphs) {
      blocks.push({
        text: p.text,
        bbox: bboxFrom(p.bbox),
        confidence: normalizeConfidence(p.confidence),
        kind: "paragraph",
      })
    }
  }

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

/** tesseract.js reports confidence 0-100; OcrBlock wants 0-1. */
function normalizeConfidence(confidence: number | undefined): number | undefined {
  return typeof confidence === "number" ? confidence / 100 : undefined
}

function bboxFrom(bbox: TesseractBbox | undefined): OcrBlock["bbox"] | undefined {
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
