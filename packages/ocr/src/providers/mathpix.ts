/**
 * Mathpix OCR provider — math/formula specialist.
 *
 * Images — POST https://api.mathpix.com/v3/text
 *   headers: app_id, app_key, Content-Type: application/json
 *   body: { src: "<data-url>", formats: ["text", "data"], math_inline_delimiters: ["$","$"] }
 *   response: { text, latex_styled, data: [{ type, value }], ... }
 *   Documented request limit: 2 MB base64-encoded image (enforced pre-upload).
 *
 * PDFs — async v3/pdf flow (v3/text is image-only):
 *   1. POST https://api.mathpix.com/v3/pdf as multipart form-data with a
 *      `file` part and an `options_json` part → { pdf_id }
 *   2. GET  https://api.mathpix.com/v3/pdf/{pdf_id} until status "completed"
 *      (statuses: received | loaded | split | completed | error)
 *   3. GET  https://api.mathpix.com/v3/pdf/{pdf_id}.lines.json for per-page
 *      line data ({ pages: [{ page, page_width, page_height, lines }] });
 *      falls back to GET {pdf_id}.mmd (combined Mathpix Markdown).
 */

import { bytesToBase64, isPdfMimeType, normalizeImage } from "../image-prep"
import { OcrError } from "../errors"
import { type OcrInput, type OcrProvider, type OcrProviderContext, type OcrResult } from "../types"
import { cloudFetch, defaultErrorCodeFor, parseJson, requireSecret } from "./_http"

const MATHPIX_ENDPOINT = "https://api.mathpix.com/v3/text"
const MATHPIX_PDF_ENDPOINT = "https://api.mathpix.com/v3/pdf"
/** Documented v3/text request limit: 2 MB base64-encoded image. */
const MATHPIX_MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024

export interface MathpixConfig {
  endpoint?: string
  /** Base URL for the async PDF flow. Default https://api.mathpix.com/v3/pdf */
  pdfEndpoint?: string
  formats?: ("text" | "data" | "latex_styled" | "html")[]
  /** Override poll delay for tests. Default 1000ms. */
  pollIntervalMs?: number
  /** Hard cap on poll iterations. Default 60 (≈60s at default interval). */
  maxPolls?: number
  fetchImpl?: typeof fetch
}

interface MathpixErrorFields {
  error?: string
  error_info?: { id?: string; message?: string }
}

interface MathpixResponse extends MathpixErrorFields {
  text?: string
  latex_styled?: string
  html?: string
  data?: Array<{ type?: string; value?: string }>
}

interface MathpixPdfSubmitResponse extends MathpixErrorFields {
  pdf_id?: string
}

interface MathpixPdfStatusResponse extends MathpixErrorFields {
  status?: "received" | "loaded" | "split" | "completed" | "error"
  num_pages?: number
  num_pages_completed?: number
  percent_done?: number
}

interface MathpixPdfLine {
  text?: string
  text_display?: string
}

interface MathpixPdfPageData {
  page?: number
  page_width?: number
  page_height?: number
  lines?: MathpixPdfLine[]
}

interface MathpixPdfLinesResponse extends MathpixErrorFields {
  pages?: MathpixPdfPageData[]
}

export function buildMathpixProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "mathpix",
    label: "Mathpix",
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["appId", "appKey"],
    async extract(input, ctx) {
      return mathpixExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function mathpixExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const appId = requireSecret("mathpix", ctx.credentials.secrets, "appId")
  const appKey = requireSecret("mathpix", ctx.credentials.secrets, "appKey")
  const config = (ctx.config ?? {}) as MathpixConfig
  const fetchFn = fetchImpl ?? config.fetchImpl
  const headers = { app_id: appId, app_key: appKey }

  const normalized = await normalizeImage(input.source)
  if (isPdfMimeType(normalized.mimeType)) {
    return mathpixExtractPdf(input, ctx, config, headers, normalized.bytes, fetchFn)
  }
  return mathpixExtractImage(input, ctx, config, headers, normalized, fetchFn)
}

// ─── Image path (v3/text) ───────────────────────────────────────────────────

async function mathpixExtractImage(
  input: OcrInput,
  ctx: OcrProviderContext,
  config: MathpixConfig,
  headers: Record<string, string>,
  normalized: { bytes: Uint8Array; mimeType: string },
  fetchFn?: typeof fetch
): Promise<OcrResult> {
  const endpoint = config.endpoint ?? MATHPIX_ENDPOINT
  const formats = config.formats ?? ["text", "data"]

  const base64 = bytesToBase64(normalized.bytes)
  if (base64.length > MATHPIX_MAX_IMAGE_BASE64_BYTES) {
    throw new OcrError(
      "invalid_input",
      "mathpix",
      `Image exceeds the Mathpix v3/text limit of 2 MB base64-encoded ` +
        `(got ${(base64.length / (1024 * 1024)).toFixed(1)} MB). ` +
        `Downscale or compress the image before OCR.`
    )
  }
  const dataUrl = `data:${normalized.mimeType};base64,${base64}`
  const start = Date.now()
  const res = await cloudFetch({
    providerId: "mathpix",
    url: endpoint,
    headers,
    body: {
      src: dataUrl,
      formats,
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
    },
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })
  const data = parseJson<MathpixResponse>("mathpix", res.body)
  throwOnMathpixError(data)
  const markdown = data.text ?? data.latex_styled ?? data.html ?? ""
  return {
    providerId: "mathpix",
    pages: [{ pageNumber: 1, markdown, text: stripMathDelims(markdown) }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
    costEstimate: { unit: "image", amount: 0.004, currency: "USD" },
  }
}

// ─── PDF path (async v3/pdf) ────────────────────────────────────────────────

async function mathpixExtractPdf(
  input: OcrInput,
  ctx: OcrProviderContext,
  config: MathpixConfig,
  headers: Record<string, string>,
  bytes: Uint8Array,
  fetchFn?: typeof fetch
): Promise<OcrResult> {
  const pdfEndpoint = (config.pdfEndpoint ?? MATHPIX_PDF_ENDPOINT).replace(/\/+$/, "")
  const pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 1000)
  const maxPolls = Math.max(1, config.maxPolls ?? 60)
  const start = Date.now()

  // 1. Submit — multipart form-data with `file` + `options_json` parts.
  const form = new FormData()
  form.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), "document.pdf")
  form.append(
    "options_json",
    JSON.stringify({
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
    })
  )
  const submitBody = await mathpixMultipartPost(pdfEndpoint, headers, form, ctx.signal, fetchFn)
  const submit = parseJson<MathpixPdfSubmitResponse>("mathpix", submitBody)
  throwOnMathpixError(submit)
  const pdfId = submit.pdf_id
  if (!pdfId) {
    throw new OcrError("provider_failed", "mathpix", "Mathpix v3/pdf did not return a pdf_id.")
  }

  // 2. Poll GET /v3/pdf/{pdf_id} until status "completed" (bounded budget).
  let status: MathpixPdfStatusResponse | null = null
  for (let i = 0; i < maxPolls; i++) {
    if (ctx.signal?.aborted) {
      throw new OcrError("aborted", "mathpix", "OCR cancelled while polling Mathpix PDF status.")
    }
    const pollRes = await cloudFetch({
      providerId: "mathpix",
      method: "GET",
      url: `${pdfEndpoint}/${encodeURIComponent(pdfId)}`,
      headers,
      signal: ctx.signal,
      fetchImpl: fetchFn,
    })
    status = parseJson<MathpixPdfStatusResponse>("mathpix", pollRes.body)
    if (status.status === "completed") break
    if (status.status === "error") {
      throw new OcrError(
        "provider_failed",
        "mathpix",
        status.error_info?.message ?? status.error ?? "Mathpix PDF processing failed."
      )
    }
    if (i < maxPolls - 1 && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }
  if (!status || status.status !== "completed") {
    throw new OcrError(
      "provider_failed",
      "mathpix",
      "Mathpix PDF processing did not complete within the poll budget."
    )
  }

  // 3. Fetch per-page line data; fall back to combined .mmd markdown.
  const pages = await fetchPdfPages(pdfEndpoint, pdfId, headers, ctx.signal, fetchFn)
  return {
    providerId: "mathpix",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
    // v3/pdf pricing: $0.025 per page at the base tier.
    costEstimate: { unit: "page", amount: pages.length * 0.025, currency: "USD" },
  }
}

async function fetchPdfPages(
  pdfEndpoint: string,
  pdfId: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchFn?: typeof fetch
): Promise<OcrResult["pages"]> {
  const linesRes = await cloudFetch({
    providerId: "mathpix",
    method: "GET",
    url: `${pdfEndpoint}/${encodeURIComponent(pdfId)}.lines.json`,
    headers,
    signal,
    fetchImpl: fetchFn,
  })
  const lines = parseJson<MathpixPdfLinesResponse>("mathpix", linesRes.body)
  throwOnMathpixError(lines)
  const pageData = lines.pages ?? []
  if (pageData.length > 0) {
    return pageData.map((page, i) => {
      const markdown = (page.lines ?? [])
        .map((line) => line.text_display ?? line.text ?? "")
        .filter((s) => s.length > 0)
        .join("\n")
      return {
        pageNumber: page.page ?? i + 1,
        markdown,
        text: stripMathDelims(markdown),
        width: page.page_width,
        height: page.page_height,
      }
    })
  }
  // No line data — fall back to the combined Mathpix Markdown output.
  const mmdRes = await cloudFetch({
    providerId: "mathpix",
    method: "GET",
    url: `${pdfEndpoint}/${encodeURIComponent(pdfId)}.mmd`,
    headers,
    signal,
    fetchImpl: fetchFn,
  })
  const markdown = mmdRes.body
  return [{ pageNumber: 1, markdown, text: stripMathDelims(markdown) }]
}

/**
 * Multipart POST for the PDF submit. `cloudFetch` JSON-encodes object bodies,
 * so FormData has to go through fetch directly; abort + HTTP-status → OcrError
 * mapping mirror `cloudFetch` semantics.
 */
async function mathpixMultipartPost(
  url: string,
  headers: Record<string, string>,
  form: FormData,
  signal: AbortSignal | undefined,
  fetchFn?: typeof fetch
): Promise<string> {
  const fetchImpl = fetchFn ?? globalThis.fetch
  if (!fetchImpl) {
    throw new OcrError("provider_failed", "mathpix", "fetch is unavailable in this runtime")
  }
  if (signal?.aborted) {
    throw new OcrError("aborted", "mathpix", "OCR request was cancelled.")
  }
  let response: Response
  try {
    // No Content-Type header — fetch sets the multipart boundary itself.
    response = await fetchImpl(url, { method: "POST", headers, body: form, signal })
  } catch (err) {
    if (err instanceof DOMException && (err.name === "AbortError" || err.message === "aborted")) {
      throw new OcrError("aborted", "mathpix", "OCR request was cancelled.", err)
    }
    throw new OcrError(
      "provider_failed",
      "mathpix",
      err instanceof Error ? err.message : String(err),
      err
    )
  }
  const text = await response.text()
  if (!response.ok) {
    throw new OcrError(
      defaultErrorCodeFor(response.status),
      "mathpix",
      `mathpix HTTP ${response.status}: ${text.slice(0, 240)}`
    )
  }
  return text
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Map Mathpix in-body errors to OcrError codes (same rules on both paths). */
function throwOnMathpixError(data: MathpixErrorFields): void {
  if (!data.error && !data.error_info) return
  const msg = data.error_info?.message ?? data.error ?? "Mathpix error"
  const code = /rate.?limit/i.test(msg)
    ? "rate_limited"
    : /unauth|invalid.*key|forbidden/i.test(msg)
      ? "missing_credentials"
      : "provider_failed"
  throw new OcrError(code, "mathpix", msg)
}

function stripMathDelims(markdown: string): string {
  return markdown.replace(/\$\$/g, "").replace(/\$/g, "")
}

export const mathpixProvider = buildMathpixProvider()
