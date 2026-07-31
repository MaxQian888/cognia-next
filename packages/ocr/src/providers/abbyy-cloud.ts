/**
 * ABBYY Cloud OCR SDK provider (API v2, JSON).
 *
 * NOTE — End-of-Sale: ABBYY Cloud OCR SDK has been End-of-Sale since
 * 2023-01-01. No new customers can be provisioned; the service continues in a
 * production-support state for existing customers only (the announced EOL was
 * extended and later rescinded). ABBYY's successor product is ABBYY Vantage.
 * Keep this provider working for existing credentials, but do not expect new
 * sign-ups to be possible.
 *
 * Two-stage workflow (https://support.abbyy.com/hc/en-us/articles/360017326479):
 *   1. POST <region>.ocrsdk.com/v2/processImage?language=<...>&exportFormat=<...>
 *      Basic auth (application_id : password); body is the image bytes.
 *      JSON response: { taskId, status, resultUrls: [...], error?, ... }.
 *   2. Poll GET <region>.ocrsdk.com/v2/getTaskStatus?taskId=<id> until
 *      status === "Completed", then GET the first resultUrls entry, which
 *      serves the exported result (unauthenticated, time-limited URL).
 *
 * A tolerant parser also accepts the legacy v1 XML task envelope
 * (<task id=".." status=".." resultUrl=".."/>) because `endpoint` is
 * user-overridable and may point at a v1-style server.
 */

import { normalizeImage } from "../image-prep"
import { OcrError } from "../errors"
import { type OcrInput, type OcrProvider, type OcrProviderContext, type OcrResult } from "../types"
import { cloudFetch, requireSecret } from "./_http"

const ABBYY_DEFAULT_ENDPOINT = "https://cloud-eu.ocrsdk.com"

export interface AbbyyConfig {
  endpoint?: string
  exportFormat?: "txt" | "txtUnstructured" | "rtf" | "xml" | "alto"
  /** Pause between polls in ms. Default 1500. */
  pollIntervalMs?: number
  /** Max polls before giving up. Default 40 (~60s at default interval). */
  maxPolls?: number
  fetchImpl?: typeof fetch
}

interface AbbyyTask {
  id: string
  status: string
  resultUrl?: string
  error?: string
}

/** v2 JSON task envelope (subset) — see HTTP status codes and response formats doc. */
interface AbbyyV2TaskResponse {
  taskId?: string
  status?: string
  resultUrls?: string[]
  error?: string
}

/** Task statuses that will never progress to Completed — fail fast instead of polling. */
const TERMINAL_FAILURE_STATUSES = new Set(["ProcessingFailed", "NotEnoughCredits", "Deleted"])

export function buildAbbyyCloudProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "abbyy-cloud",
    label: "ABBYY Cloud OCR",
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["applicationId", "password"],
    async extract(input, ctx) {
      return abbyyCloudExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function abbyyCloudExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const applicationId = requireSecret("abbyy-cloud", ctx.credentials.secrets, "applicationId")
  const password = requireSecret("abbyy-cloud", ctx.credentials.secrets, "password")
  const config = (ctx.config ?? {}) as AbbyyConfig
  const baseUrl = (config.endpoint ?? ABBYY_DEFAULT_ENDPOINT).replace(/\/+$/, "")
  const exportFormat = config.exportFormat ?? "txt"
  const pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 1500)
  const maxPolls = Math.max(1, config.maxPolls ?? 40)
  const fetchFn = fetchImpl ?? config.fetchImpl
  const authHeader = "Basic " + base64(`${applicationId}:${password}`)
  const language = (input.languages ?? []).map(mapLanguage).join(",") || "English"

  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  const submit = await cloudFetch({
    providerId: "abbyy-cloud",
    url: `${baseUrl}/v2/processImage?language=${encodeURIComponent(
      language
    )}&exportFormat=${encodeURIComponent(exportFormat)}`,
    headers: {
      Authorization: authHeader,
      "Content-Type": normalized.mimeType || "application/octet-stream",
      Accept: "application/json",
    },
    body: normalized.bytes,
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })
  const initial = parseAbbyyTask(submit.body)

  let task = initial
  for (let i = 0; i < maxPolls; i++) {
    if (task.status === "Completed") break
    if (TERMINAL_FAILURE_STATUSES.has(task.status)) {
      throw new OcrError("provider_failed", "abbyy-cloud", task.error ?? task.status)
    }
    if (ctx.signal?.aborted) {
      throw new OcrError("aborted", "abbyy-cloud", "OCR cancelled while polling ABBYY task.")
    }
    if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs))
    const poll = await cloudFetch({
      providerId: "abbyy-cloud",
      method: "GET",
      url: `${baseUrl}/v2/getTaskStatus?taskId=${encodeURIComponent(task.id)}`,
      headers: { Authorization: authHeader, Accept: "application/json" },
      signal: ctx.signal,
      fetchImpl: fetchFn,
    })
    task = parseAbbyyTask(poll.body)
  }
  if (task.status !== "Completed" || !task.resultUrl) {
    throw new OcrError(
      "provider_failed",
      "abbyy-cloud",
      "ABBYY task did not complete within the poll budget."
    )
  }
  const result = await cloudFetch({
    providerId: "abbyy-cloud",
    method: "GET",
    url: task.resultUrl,
    headers: { Accept: "*/*" },
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })
  const text = result.body
  return {
    providerId: "abbyy-cloud",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

function parseAbbyyTask(body: string): AbbyyTask {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as AbbyyV2TaskResponse
      if (parsed.taskId && parsed.status) {
        return {
          id: parsed.taskId,
          status: parsed.status,
          // Up to 3 export formats are possible; we configure exactly one,
          // so the first URL is the result for the configured exportFormat.
          resultUrl: Array.isArray(parsed.resultUrls) ? parsed.resultUrls[0] : undefined,
          error: parsed.error,
        }
      }
    } catch {
      /* fall through to XML */
    }
  }
  // Legacy v1 XML envelope — kept because a custom `endpoint` may target a v1 server.
  const id = /<task[^>]*id="([^"]+)"/i.exec(trimmed)?.[1]
  const status = /status="([^"]+)"/i.exec(trimmed)?.[1]
  const resultUrl = /resultUrl="([^"]+)"/i.exec(trimmed)?.[1]
  const error = /error="([^"]+)"/i.exec(trimmed)?.[1]
  if (!id || !status) {
    throw new OcrError("provider_failed", "abbyy-cloud", "Failed to parse ABBYY task response.")
  }
  return { id, status, resultUrl, error }
}

function base64(input: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(input, "utf-8").toString("base64")
  return btoa(input)
}

function mapLanguage(bcp47: string): string {
  const lower = bcp47.toLowerCase().split("-")[0]
  switch (lower) {
    case "en":
      return "English"
    case "zh":
      return "ChineseSimplified"
    case "ja":
      return "Japanese"
    case "ko":
      return "Korean"
    case "de":
      return "German"
    case "fr":
      return "French"
    case "es":
      return "Spanish"
    case "it":
      return "Italian"
    case "pt":
      return "Portuguese"
    case "ru":
      return "Russian"
    case "ar":
      return "Arabic"
    default:
      return lower.charAt(0).toUpperCase() + lower.slice(1)
  }
}

export const abbyyCloudProvider = buildAbbyyCloudProvider()
