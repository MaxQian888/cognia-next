/**
 * Azure AI Document Intelligence OCR provider.
 *
 * Two-step protocol:
 *   1. POST <endpoint>/documentintelligence/documentModels/<model>:analyze
 *      ?api-version=2024-11-30
 *      → 202 Accepted, Operation-Location response header
 *   2. GET that Operation-Location until status === "succeeded" or "failed"
 *
 * Returns per-page Markdown plus structured paragraph blocks. The default
 * model is `prebuilt-read`; users can pick `prebuilt-layout` for richer
 * structured output.
 */

import { bytesToBase64, normalizeImage } from "../image-prep"
import {
  OcrError,
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, parseJson, requireSecret } from "./_http"

export interface AzureDocIntelConfig {
  endpoint?: string
  model?: string
  apiVersion?: string
  /** Override poll delay for tests. Default 1000ms. */
  pollIntervalMs?: number
  /** Hard cap on poll iterations. Default 60 (≈60s at default interval). */
  maxPolls?: number
  fetchImpl?: typeof fetch
}

interface AzurePolygon {
  /** Even-indexed entries are x, odd-indexed are y. Coords are in inches. */
  values?: number[]
}
interface AzureBoundingRegion {
  pageNumber?: number
  polygon?: number[]
}
interface AzureWord {
  content?: string
  confidence?: number
  polygon?: number[]
}
interface AzureLine {
  content?: string
  polygon?: number[]
}
interface AzureParagraph {
  content?: string
  boundingRegions?: AzureBoundingRegion[]
  role?: string
}
interface AzurePage {
  pageNumber?: number
  angle?: number
  width?: number
  height?: number
  unit?: string
  words?: AzureWord[]
  lines?: AzureLine[]
}
interface AzureAnalyzeResult {
  content?: string
  pages?: AzurePage[]
  paragraphs?: AzureParagraph[]
}
interface AzureOperationResponse {
  status?: "running" | "succeeded" | "failed" | "notStarted"
  createdDateTime?: string
  lastUpdatedDateTime?: string
  analyzeResult?: AzureAnalyzeResult
  error?: { code?: string; message?: string }
}

export function buildAzureDocIntelligenceProvider(
  inject: { fetchImpl?: typeof fetch } = {}
): OcrProvider {
  return {
    id: "azure-document-intelligence",
    label: "Azure AI Document Intelligence",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey", "endpoint"],
    async extract(input, ctx) {
      return azureDocIntelExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function azureDocIntelExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = requireSecret("azure-document-intelligence", ctx.credentials.secrets, "apiKey")
  const credsEndpoint = ctx.credentials.secrets["endpoint"]
  const config = (ctx.config ?? {}) as AzureDocIntelConfig
  const endpoint = (config.endpoint ?? credsEndpoint ?? "").trim()
  if (!endpoint) {
    throw new OcrError(
      "missing_credentials",
      "azure-document-intelligence",
      "Azure Document Intelligence requires an endpoint."
    )
  }
  const baseUrl = endpoint.replace(/\/+$/, "")
  const model = config.model ?? "prebuilt-read"
  const apiVersion = config.apiVersion ?? "2024-11-30"
  const analyzeUrl = `${baseUrl}/documentintelligence/documentModels/${encodeURIComponent(
    model
  )}:analyze?api-version=${encodeURIComponent(apiVersion)}`
  const pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 1000)
  const maxPolls = Math.max(1, config.maxPolls ?? 60)
  const fetchFn = fetchImpl ?? config.fetchImpl

  const normalized = await normalizeImage(input.source)
  const base64 = bytesToBase64(normalized.bytes)
  const start = Date.now()
  const submit = await cloudFetch({
    providerId: "azure-document-intelligence",
    url: analyzeUrl,
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      Accept: "application/json",
    },
    body: { base64Source: base64 },
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })

  const operationLocation = submit.headers.get("operation-location")
  if (!operationLocation) {
    throw new OcrError(
      "provider_failed",
      "azure-document-intelligence",
      "Azure response did not include an operation-location header."
    )
  }

  let polled: AzureOperationResponse | null = null
  for (let i = 0; i < maxPolls; i++) {
    if (ctx.signal?.aborted) {
      throw new OcrError(
        "aborted",
        "azure-document-intelligence",
        "OCR cancelled while polling Azure operation."
      )
    }
    const pollRes = await cloudFetch({
      providerId: "azure-document-intelligence",
      method: "GET",
      url: operationLocation,
      headers: { "Ocp-Apim-Subscription-Key": apiKey, Accept: "application/json" },
      signal: ctx.signal,
      fetchImpl: fetchFn,
    })
    polled = parseJson<AzureOperationResponse>("azure-document-intelligence", pollRes.body)
    if (polled.status === "succeeded") break
    if (polled.status === "failed") {
      throw new OcrError(
        "provider_failed",
        "azure-document-intelligence",
        polled.error?.message ?? "Azure analyze operation failed."
      )
    }
    if (i < maxPolls - 1 && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }
  if (!polled || polled.status !== "succeeded") {
    throw new OcrError(
      "provider_failed",
      "azure-document-intelligence",
      "Azure analyze operation did not complete within the poll budget."
    )
  }

  const analyze = polled.analyzeResult ?? {}
  const pages = (analyze.pages ?? [{}]).map((page, i): OcrResult["pages"][number] => {
    const pageNumber = page.pageNumber ?? i + 1
    const paragraphs = (analyze.paragraphs ?? []).filter((p) =>
      p.boundingRegions?.some((r) => r.pageNumber === pageNumber)
    )
    const blocks: OcrBlock[] = paragraphs.map((p) => ({
      text: p.content ?? "",
      bbox: polygonBox(p.boundingRegions?.[0]?.polygon),
      kind: "paragraph",
    }))
    const text = (page.lines ?? []).map((line) => line.content ?? "").join("\n")
    const markdown =
      paragraphs.length > 0 ? paragraphs.map((p) => p.content ?? "").join("\n\n") : text
    return {
      pageNumber,
      markdown,
      text,
      blocks,
      width: page.width,
      height: page.height,
    }
  })

  return {
    providerId: "azure-document-intelligence",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

/**
 * Azure encodes polygons as a flat [x1,y1,x2,y2,...] number array (Document
 * Intelligence v4) — older shapes used `{ values: [...] }`. Handle both.
 */
function polygonBox(polygon: number[] | AzurePolygon | undefined): OcrBlock["bbox"] | undefined {
  if (!polygon) return undefined
  const values = Array.isArray(polygon) ? polygon : polygon.values
  if (!values || values.length < 2) return undefined
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < values.length; i += 2) {
    xs.push(values[i]!)
    ys.push(values[i + 1] ?? 0)
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  }
}

export const azureDocIntelligenceProvider = buildAzureDocIntelligenceProvider()
