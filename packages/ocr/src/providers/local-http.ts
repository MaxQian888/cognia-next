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
  /** Explicit confirmation for private/LAN targets. Must match endpoint exactly. */
  allowLan?: boolean
  /** Endpoint captured when the user confirmed LAN access. */
  confirmedLanEndpoint?: string
  /** Override fetch — tests inject a mock here. */
  fetchImpl?: typeof fetch
}

export interface LocalHttpTransportRequest {
  requestId: string
  url: string
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  allowPrivateNetwork: boolean
}

export interface LocalHttpTransportResponse {
  status: number
  body: string
  contentType?: string
}

export interface LocalHttpTransport {
  request(request: LocalHttpTransportRequest): Promise<LocalHttpTransportResponse>
  cancel(requestId: string): Promise<boolean>
}

let nativeTransport: LocalHttpTransport | null = null

/** Install the packaged-desktop transport at the app composition root. */
export function __setLocalHttpTransport(transport: LocalHttpTransport | null): void {
  nativeTransport = transport
}

interface UmiOcrLineEntry {
  text: string
  score?: number
  box?: number[][]
  /** Umi-OCR's layout parser separator for this line ("", space, or newline). */
  end?: string
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
  errorCode?: number
  errorMsg?: string
  result?: {
    ocrResults?: Array<{
      prunedResult?: {
        rec_texts?: unknown[]
        rec_scores?: unknown[]
        rec_polys?: unknown[]
        rec_boxes?: unknown[]
      }
    }>
  }
}

export function buildLocalHttpProvider(): OcrProvider {
  return {
    id: "local-http",
    label: "Local HTTP (self-hosted)",
    category: "local",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey"],
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
  const transport = ctx.platform === "tauri" && !config.fetchImpl ? nativeTransport : null
  if (!transport && !fetchFn) {
    throw new OcrError("provider_failed", "local-http", "fetch is unavailable in this runtime.")
  }
  if (ctx.signal?.aborted) {
    throw new OcrError("aborted", "local-http", "OCR request was cancelled.")
  }

  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? ["en"]).map((l) => l.toLowerCase())
  const apiKey = ctx.credentials.secrets.apiKey ?? config.apiKey
  let umiLanguage: string | undefined
  if (dialect === "umi-ocr" && languages[0]) {
    umiLanguage = await discoverUmiLanguage(
      endpoint,
      languages[0],
      config,
      ctx,
      transport,
      fetchFn,
      apiKey
    )
  }
  const { body, headers } = serializeRequest(
    dialect,
    normalized.bytes,
    normalized.mimeType,
    umiLanguage ? [umiLanguage] : [],
    apiKey
  )

  const timeoutMs = config.timeoutMs ?? 30_000
  const start = Date.now()
  let response: LocalHttpTransportResponse
  try {
    response = await requestLocalHttp(
      endpoint,
      { method: "POST", headers, body: String(body) },
      config,
      ctx,
      transport,
      fetchFn
    )
  } catch (err) {
    if (err instanceof OcrError) throw err
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

  if (response.status < 200 || response.status >= 300) {
    const code =
      response.status === 401 || response.status === 403 ? "missing_credentials" : "provider_failed"
    throw new OcrError(
      code,
      "local-http",
      `local-http HTTP ${response.status}: ${truncate(response.body, 240)}`
    )
  }
  const { combinedText, blocks, width, height } = parseResponse(dialect, response.body)
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

async function requestLocalHttp(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  config: LocalHttpConfig,
  ctx: OcrProviderContext,
  transport: LocalHttpTransport | null,
  fetchFn: typeof fetch
): Promise<LocalHttpTransportResponse> {
  const timeoutMs = config.timeoutMs ?? 30_000
  const requestId = createRequestId()
  if (transport) {
    const normalizedEndpoint = normalizeEndpoint(config.endpoint ?? "")
    const allowPrivateNetwork =
      config.allowLan === true &&
      normalizeEndpoint(config.confirmedLanEndpoint ?? "") === normalizedEndpoint
    const onAbort = () => void transport.cancel(requestId)
    ctx.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      if (ctx.signal?.aborted) {
        throw new OcrError("aborted", "local-http", "OCR request was cancelled.")
      }
      return await transport.request({
        requestId,
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        timeoutMs,
        allowPrivateNetwork,
      })
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof Error && /cancelled/i.test(error.message))) {
        throw new OcrError("aborted", "local-http", "OCR request was cancelled.", error)
      }
      throw error
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort)
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  ctx.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const response = await fetchFn(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      redirect: "error",
    })
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? undefined,
    }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener("abort", onAbort)
  }
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ocr-http-${Date.now()}-${Math.random()}`
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint.trim())
    url.hash = ""
    return url.toString()
  } catch {
    return endpoint.trim()
  }
}

function umiOptionsUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = "/api/ocr/get_options"
  url.search = ""
  url.hash = ""
  return url.toString()
}

async function discoverUmiLanguage(
  endpoint: string,
  language: string,
  config: LocalHttpConfig,
  ctx: OcrProviderContext,
  transport: LocalHttpTransport | null,
  fetchFn: typeof fetch,
  apiKey?: string
): Promise<string | undefined> {
  try {
    const response = await requestLocalHttp(
      umiOptionsUrl(endpoint),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      config,
      ctx,
      transport,
      fetchFn
    )
    if (response.status < 200 || response.status >= 300) return undefined
    const payload = JSON.parse(response.body) as Record<string, unknown>
    const languageDefinition = payload["ocr.language"] as
      { optionsList?: Array<[unknown, unknown]> } | undefined
    return mapUmiLanguageOption(language, languageDefinition?.optionsList ?? [])
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    return undefined
  }
}

/** Map a BCP-47 hint to the exact model value advertised by Umi-OCR. */
export function mapUmiLanguageOption(
  language: string,
  options: Array<[unknown, unknown]>
): string | undefined {
  const normalized = language.trim().toLowerCase().replaceAll("_", "-")
  const candidates = options
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string")
    .map(([value, label]) => ({
      value: String(value),
      haystack: `${String(value)} ${String(label ?? "")}`.toLowerCase(),
    }))
  const exact = candidates.find(
    ({ value, haystack }) => value.toLowerCase() === normalized || haystack === normalized
  )
  if (exact) return exact.value
  const patterns =
    normalized.startsWith("zh-hant") || normalized.startsWith("zh-tw")
      ? ["cht", "traditional", "繁體", "繁体"]
      : normalized.startsWith("zh")
        ? ["config_chinese.txt", "简体", "簡體"]
        : normalized.startsWith("en")
          ? ["config_en", "english"]
          : normalized.startsWith("ja")
            ? ["japan", "日本"]
            : normalized.startsWith("ko")
              ? ["korean", "한국"]
              : normalized.startsWith("ru")
                ? ["cyrillic", "рус"]
                : [normalized]
  return candidates.find(({ haystack }) => patterns.some((pattern) => haystack.includes(pattern)))
    ?.value
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
      // PaddleOCR 3.x / PaddleX basic serving contract (`POST /ocr`).
      headers["Content-Type"] = "application/json"
      const body = JSON.stringify({
        file: bytesToBase64(bytes),
        fileType: mimeType === "application/pdf" ? 0 : 1,
        visualize: false,
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
  let combinedText = ""
  for (const line of payload.data ?? []) {
    if (!line || typeof line.text !== "string") continue
    combinedText += line.text
    combinedText += typeof line.end === "string" ? line.end : "\n"
    const bbox = boxToBbox(line.box)
    blocks.push({
      text: line.text,
      bbox,
      confidence: typeof line.score === "number" ? line.score : undefined,
      kind: "line",
    })
  }
  return { combinedText: combinedText.replace(/\n$/, ""), blocks }
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
  if (typeof payload.errorCode === "number" && payload.errorCode !== 0) {
    throw new OcrError(
      "provider_failed",
      "local-http",
      `PaddleOCR-Server returned error ${payload.errorCode}: ${payload.errorMsg ?? "(no message)"}`
    )
  }
  const v3 = parsePaddleV3Response(payload)
  if (v3) return v3
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

function parsePaddleV3Response(payload: PaddleServerResponse): ParseResult | undefined {
  const pages = payload.result?.ocrResults
  if (!Array.isArray(pages)) return undefined
  const blocks: OcrBlock[] = []
  const lines: string[] = []
  for (const page of pages) {
    const result = page?.prunedResult
    const texts = result?.rec_texts ?? []
    const scores = result?.rec_scores ?? []
    const polygons = result?.rec_polys ?? []
    const boxes = result?.rec_boxes ?? []
    for (let index = 0; index < texts.length; index++) {
      const text = texts[index]
      if (typeof text !== "string" || text.length === 0) continue
      const score = scores[index]
      const polygon = toPolygon(polygons[index]) ?? rectToPolygon(boxes[index])
      lines.push(text)
      blocks.push({
        text,
        confidence: typeof score === "number" ? score : undefined,
        bbox: boxToBbox(polygon),
        kind: "line",
      })
    }
  }
  return { combinedText: lines.join("\n"), blocks }
}

function toPolygon(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const points = value.filter(
    (point): point is number[] =>
      Array.isArray(point) && point.length >= 2 && point.every((part) => typeof part === "number")
  )
  return points.length > 0 ? points : undefined
}

function rectToPolygon(value: unknown): number[][] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    !value.every((part) => typeof part === "number")
  ) {
    return undefined
  }
  const [xMin, yMin, xMax, yMax] = value as number[]
  return [
    [xMin!, yMin!],
    [xMax!, yMin!],
    [xMax!, yMax!],
    [xMin!, yMax!],
  ]
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
