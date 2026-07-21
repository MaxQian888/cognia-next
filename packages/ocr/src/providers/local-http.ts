/**
 * Local HTTP OCR provider — adapter for self-hosted OCR servers like
 * Umi-OCR, PaddleOCR-Server, RapidOCR-API.
 *
 * Users supply an endpoint URL + a "dialect" enum (request/response
 * shape) in settings. The provider is shell-agnostic — anything that
 * can run `fetch()` to the user's LAN works (browser, Tauri, Capacitor).
 *
 * Two dialects ship out of the box:
 *   - "umi-ocr": Umi-OCR HTTP server. JSON body with base64 image,
 *     `{ "code": 100, "data": "..." }` or `{ "code": 100, "data": [{ text, score, box }] }`
 *     depending on Umi-OCR config. See https://github.com/hiroi-sora/Umi-OCR
 *   - "paddleocr-server": PaddleOCR's serving API. JSON body with base64
 *     images; responses carry either official hubserving dict entries
 *     `{ text, confidence, text_region }` or legacy tuple entries
 *     `[bbox, [text, conf]]` under `{ "status": "...", "results": [...] }`.
 *
 * Adding a new dialect is a matter of teaching `serializeRequest` /
 * `parseResponse` how to talk to it — provider id stays stable.
 */

import { bytesToBase64, normalizeImage } from "../image-prep"
import { OcrError } from "../errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"

export type LocalHttpDialect = "umi-ocr" | "paddleocr-server"

export interface LocalHttpConfig {
  /** Required — full URL of the OCR HTTP endpoint. */
  endpoint?: string
  /** Defaults to "umi-ocr". */
  dialect?: LocalHttpDialect
  /** Optional bearer token; sent in the Authorization header when present. */
  apiKey?: string
  /** Defaults to 30s. */
  timeoutMs?: number
  /** Override fetch — tests inject a mock here. */
  fetchImpl?: typeof fetch
}

interface UmiOcrLineEntry {
  text: string
  score?: number
  box?: number[][]
}

interface UmiOcrResponse {
  code: number
  data: string | UmiOcrLineEntry[]
  /** Some Umi-OCR forks surface a human-readable error here. */
  message?: string
}

// PaddleOCR-Server entries come in two documented shapes:
//   - Official PaddleHub Serving (deploy/hubserving/readme_en.md §4):
//     dict entries `{ text, confidence, text_region: [[x,y] x4] }`.
//   - Legacy/fork tuple entries: `[bbox[4][2], [text, confidence]]`.
// Both are parsed defensively in `parsePaddleServerResponse`.
interface PaddleServerDictEntry {
  text: string
  confidence?: number
  text_region?: number[][]
}

type PaddleServerEntry = PaddleServerDictEntry | [number[][], [string, number]]

interface PaddleServerResponse {
  status?: string
  msg?: string
  results?: PaddleServerEntry[][]
}

export function buildLocalHttpProvider(): OcrProvider {
  return {
    id: "local-http",
    label: "Local HTTP (self-hosted)",
    category: "local",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    async extract(input, ctx) {
      return localHttpExtract(input, ctx)
    },
  }
}

export async function localHttpExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as LocalHttpConfig
  const endpoint = (config.endpoint ?? "").trim()
  if (!endpoint) {
    throw new OcrError(
      "invalid_input",
      "local-http",
      "local-http requires an endpoint URL — configure one in Settings → OCR."
    )
  }
  const dialect: LocalHttpDialect = config.dialect ?? "umi-ocr"
  const fetchFn = config.fetchImpl ?? globalThis.fetch
  if (!fetchFn) {
    throw new OcrError("provider_failed", "local-http", "fetch is unavailable in this runtime.")
  }
  if (ctx.signal?.aborted) {
    throw new OcrError("aborted", "local-http", "OCR request was cancelled.")
  }

  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? ["en"]).map((l) => l.toLowerCase())
  const { body, headers } = serializeRequest(
    dialect,
    normalized.bytes,
    normalized.mimeType,
    languages,
    config.apiKey
  )

  const controller = new AbortController()
  const timeoutMs = config.timeoutMs ?? 30_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Chain caller's signal so external cancellation still works.
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      controller.abort()
    } else {
      ctx.signal.addEventListener("abort", () => controller.abort(), { once: true })
    }
  }

  const start = Date.now()
  let response: Response
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new OcrError(
        "aborted",
        "local-http",
        ctx.signal?.aborted
          ? "OCR request was cancelled."
          : `local-http timed out after ${timeoutMs}ms.`,
        err
      )
    }
    throw new OcrError(
      "provider_failed",
      "local-http",
      err instanceof Error ? err.message : String(err),
      err
    )
  }
  clearTimeout(timer)

  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403 ? "missing_credentials" : "provider_failed"
    const message = await response.text().catch(() => "")
    throw new OcrError(
      code,
      "local-http",
      `local-http HTTP ${response.status}: ${truncate(message, 240)}`
    )
  }
  const text = await response.text()
  const { combinedText, blocks, width, height } = parseResponse(dialect, text)
  return {
    providerId: "local-http",
    pages: [
      {
        pageNumber: 1,
        markdown: combinedText,
        text: combinedText,
        blocks,
        width,
        height,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages,
    durationMs: Date.now() - start,
    cached: false,
  }
}

interface RequestBundle {
  body: BodyInit
  headers: Record<string, string>
}

export function serializeRequest(
  dialect: LocalHttpDialect,
  bytes: Uint8Array,
  mimeType: string,
  languages: string[],
  apiKey?: string
): RequestBundle {
  const headers: Record<string, string> = {}
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  switch (dialect) {
    case "umi-ocr": {
      headers["Content-Type"] = "application/json"
      // Umi-OCR's documented option key is "ocr.language" (docs/http/api_ocr.md),
      // and its values are Umi-OCR model-config identifiers, not BCP-47 codes.
      // We pass the user-configured string through as-is — no BCP-47 mapping
      // table exists in the upstream docs, so users must supply Umi-OCR's own
      // model-config names when they want a non-default language.
      const language = languages[0]
      const body = JSON.stringify({
        base64: bytesToBase64(bytes),
        ...(language ? { options: { "ocr.language": language } } : {}),
      })
      return { body, headers }
    }
    case "paddleocr-server": {
      // PaddleOCR-Server accepts a JSON envelope with a base64 image when
      // configured with the official deploy/serving recipe; multipart is
      // not universally supported across forks. We use JSON for
      // compatibility.
      headers["Content-Type"] = "application/json"
      const body = JSON.stringify({
        images: [bytesToBase64(bytes)],
        // PaddleOCR-Server doesn't accept a `mime_type` field today; this
        // is kept here for forks that look at it.
        mime_type: mimeType,
      })
      return { body, headers }
    }
  }
}

interface ParseResult {
  combinedText: string
  blocks: OcrBlock[]
  width?: number
  height?: number
}

export function parseResponse(dialect: LocalHttpDialect, body: string): ParseResult {
  switch (dialect) {
    case "umi-ocr":
      return parseUmiOcrResponse(body)
    case "paddleocr-server":
      return parsePaddleServerResponse(body)
  }
}

function parseUmiOcrResponse(body: string): ParseResult {
  let payload: UmiOcrResponse
  try {
    payload = JSON.parse(body) as UmiOcrResponse
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "local-http",
      "Failed to parse Umi-OCR response as JSON",
      err
    )
  }
  // Umi-OCR uses code 100 for success; everything else carries a message
  // explaining what went wrong (101 = no text found, ≥200 = error).
  if (payload.code === 101) {
    return { combinedText: "", blocks: [] }
  }
  if (payload.code !== 100) {
    throw new OcrError(
      "provider_failed",
      "local-http",
      `Umi-OCR returned code ${payload.code}: ${payload.message ?? "(no message)"}`
    )
  }
  if (typeof payload.data === "string") {
    return { combinedText: payload.data, blocks: [] }
  }
  const blocks: OcrBlock[] = []
  const lines: string[] = []
  for (const line of payload.data ?? []) {
    if (!line || typeof line.text !== "string") continue
    lines.push(line.text)
    const bbox = boxToBbox(line.box)
    blocks.push({
      text: line.text,
      bbox,
      confidence: typeof line.score === "number" ? line.score : undefined,
      kind: "line",
    })
  }
  return { combinedText: lines.join("\n"), blocks }
}

function parsePaddleServerResponse(body: string): ParseResult {
  let payload: PaddleServerResponse
  try {
    payload = JSON.parse(body) as PaddleServerResponse
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      "local-http",
      "Failed to parse PaddleOCR-Server response as JSON",
      err
    )
  }
  if (payload.status && payload.status !== "ok" && payload.status !== "000") {
    throw new OcrError(
      "provider_failed",
      "local-http",
      `PaddleOCR-Server returned status ${payload.status}: ${payload.msg ?? "(no message)"}`
    )
  }
  const blocks: OcrBlock[] = []
  const lines: string[] = []
  const firstImage = (payload.results ?? [])[0] ?? []
  let unparseable = 0
  for (const entry of firstImage) {
    const parsed = parsePaddleServerEntry(entry)
    if (!parsed) {
      unparseable++
      continue
    }
    if (!parsed.text) continue
    lines.push(parsed.text)
    blocks.push({
      text: parsed.text,
      bbox: boxToBbox(parsed.box),
      confidence: parsed.confidence,
      kind: "line",
    })
  }
  // No silent skips: if a non-empty result set matched neither documented
  // shape, surface it instead of returning an empty success.
  if (unparseable > 0 && unparseable === firstImage.length) {
    throw new OcrError(
      "provider_failed",
      "local-http",
      `PaddleOCR-Server response contained ${unparseable} entr${
        unparseable === 1 ? "y" : "ies"
      }, none matching the official dict shape ({text, confidence, text_region}) or the legacy tuple shape ([bbox, [text, conf]]).`
    )
  }
  return { combinedText: lines.join("\n"), blocks }
}

interface ParsedPaddleEntry {
  text: string
  confidence?: number
  box?: number[][]
}

/**
 * Accepts both documented PaddleOCR-Server entry shapes:
 *   - official hubserving dict: `{ text, confidence, text_region }`
 *   - legacy tuple: `[bbox[4][2], [text, confidence]]`
 * Returns undefined when the entry matches neither.
 */
function parsePaddleServerEntry(entry: unknown): ParsedPaddleEntry | undefined {
  if (!entry) return undefined
  if (Array.isArray(entry)) {
    const bboxRaw = entry[0]
    const textPair = entry[1]
    if (!Array.isArray(textPair) || textPair.length < 2) return undefined
    return {
      text: String(textPair[0] ?? ""),
      confidence: typeof textPair[1] === "number" ? textPair[1] : undefined,
      box: Array.isArray(bboxRaw) ? (bboxRaw as number[][]) : undefined,
    }
  }
  if (typeof entry === "object") {
    const dict = entry as Partial<PaddleServerDictEntry>
    if (typeof dict.text !== "string") return undefined
    return {
      text: dict.text,
      confidence: typeof dict.confidence === "number" ? dict.confidence : undefined,
      box: Array.isArray(dict.text_region) ? dict.text_region : undefined,
    }
  }
  return undefined
}

function boxToBbox(box: number[][] | undefined): OcrBlock["bbox"] | undefined {
  if (!Array.isArray(box) || box.length === 0) return undefined
  let xMin = Infinity
  let yMin = Infinity
  let xMax = -Infinity
  let yMax = -Infinity
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) continue
    const x = Number(point[0])
    const y = Number(point[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < xMin) xMin = x
    if (y < yMin) yMin = y
    if (x > xMax) xMax = x
    if (y > yMax) yMax = y
  }
  if (
    !Number.isFinite(xMin) ||
    !Number.isFinite(yMin) ||
    !Number.isFinite(xMax) ||
    !Number.isFinite(yMax)
  ) {
    return undefined
  }
  return { x: xMin, y: yMin, width: Math.max(0, xMax - xMin), height: Math.max(0, yMax - yMin) }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

export const localHttpProvider = buildLocalHttpProvider()
