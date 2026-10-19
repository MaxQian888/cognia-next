/**
 * Vendor Reader adapters: Tavily Extract, Exa Contents, DeepSeek Fetch and
 * TinyFish Fetch, each reading exactly one public URL.
 *
 * Thin mapping only. The HTTP wire lives in the `@cognia/web-search` provider
 * modules (so the installed proxy transport, CSP bypass and cancellation all
 * apply); this module turns each vendor's success / per-URL failure /
 * request-level failure into the shared {@link StageOutcome} vocabulary.
 *
 * Credentials are the vendor's stored SEARCH credential, resolved by the host;
 * nothing here reads settings or stores a key. A vendor's envelope success
 * never implies per-URL success: Tavily `failed_results`, Exa `statuses[]` and
 * TinyFish `errors[]` all map to failures, never to empty content.
 */

import type { CredentialedWebReaderId } from "@cognia/agent-config-types"
import { extractWithTavily } from "@cognia/web-search/providers/tavily"
import { readWithExa } from "@cognia/web-search/providers/exa"
import { fetchWithDeepSeek } from "@cognia/web-search/providers/deepseek"
import { fetchWithTinyFish } from "@cognia/web-search/providers/tinyfish"
import { extractHttpStatus } from "@cognia/web-search/retry"
import { isAbortLike } from "@cognia/web-search/operation-policy"
import {
  boundedDetail,
  type ReadFailure,
  type ReadFailureClass,
  type StageOutcome,
} from "./read-outcome"

/** Map a vendor's request-level HTTP status onto a routing class. */
export function classifyVendorStatus(status: number | undefined): ReadFailureClass {
  if (status === undefined) return "vendor-error"
  if (status === 401) return "vendor-auth"
  // 402 balance, 432/433 Tavily plan/PAYGO caps.
  if (status === 402 || status === 432 || status === 433) return "vendor-quota"
  if (status === 429) return "vendor-rate-limit"
  // DeepSeek 403 is its safety refusal; 404 "no usable content".
  if (status === 403) return "vendor-refused"
  if (status === 404) return "thin"
  if (status === 408 || status === 504) return "attempt-timeout"
  return "vendor-error"
}

/** Map a per-URL vendor failure tag onto a routing class. */
export function classifyVendorUrlError(tag: string, targetStatus?: number): ReadFailureClass {
  const t = tag.toLowerCase()
  if (
    t.includes("not_found") ||
    t === "crawl_not_found" ||
    targetStatus === 404 ||
    targetStatus === 410
  ) {
    return "not-found"
  }
  if (t.includes("login") || targetStatus === 401) return "auth-required"
  if (t.includes("too_large")) return "too-large"
  if (t.includes("bot") || targetStatus === 403 || targetStatus === 429) return "anti-bot"
  if (t.includes("timeout")) return "attempt-timeout"
  if (t.includes("invalid_url") || t.includes("unsupported_url")) return "invalid"
  if (t.includes("empty")) return "thin"
  return "vendor-error"
}

function failure(
  reader: CredentialedWebReaderId,
  cls: ReadFailureClass,
  detail: string,
  status?: number
): ReadFailure {
  return {
    kind: "failure",
    reader,
    failure: cls,
    detail: boundedDetail(detail),
    ...(status !== undefined ? { status, statusSource: "reader-service" as const } : {}),
  }
}

/**
 * Run one vendor reader. Never throws except for cancellation, which the
 * caller must see as cancellation rather than a vendor failure.
 */
export async function readWithVendor(
  reader: CredentialedWebReaderId,
  url: string,
  apiKey: string,
  options: { signal: AbortSignal; attemptBudgetMs: number }
): Promise<StageOutcome> {
  try {
    switch (reader) {
      case "tavily": {
        const outcome = await extractWithTavily(url, apiKey, {
          signal: options.signal,
          timeoutSeconds: Math.ceil(options.attemptBudgetMs / 1000),
        })
        if (!outcome.ok)
          return failure(reader, classifyVendorUrlError(outcome.error), outcome.error)
        return content(reader, outcome.markdown)
      }
      case "exa": {
        const outcome = await readWithExa(url, apiKey, {
          signal: options.signal,
          livecrawlTimeoutMs: options.attemptBudgetMs,
        })
        if (!outcome.ok) {
          return failure(
            reader,
            classifyVendorUrlError(outcome.tag, outcome.httpStatusCode),
            outcome.tag
          )
        }
        return content(reader, outcome.text, outcome.title)
      }
      case "deepseek": {
        const outcome = await fetchWithDeepSeek(url, apiKey, options.signal)
        if (!outcome.markdown.trim()) return failure(reader, "thin", "empty_content")
        return content(reader, outcome.markdown, outcome.title)
      }
      case "tinyfish": {
        const outcome = await fetchWithTinyFish(url, apiKey, {
          signal: options.signal,
          perUrlTimeoutMs: options.attemptBudgetMs,
        })
        if (!outcome.ok) {
          return failure(
            reader,
            classifyVendorUrlError(outcome.error.error, outcome.error.status),
            outcome.error.error
          )
        }
        return content(reader, outcome.markdown, outcome.title)
      }
    }
  } catch (error) {
    if (options.signal.aborted || isAbortLike(error)) throw error
    const status = extractHttpStatus(error)
    return failure(reader, classifyVendorStatus(status), boundedDetail(error), status)
  }
}

function content(reader: CredentialedWebReaderId, text: string, title?: string): StageOutcome {
  return {
    kind: "content",
    reader,
    source: reader,
    text,
    ...(title ? { title } : {}),
    contentType: "text/markdown",
    status: 200,
    statusSource: "reader-service",
    extraction: "markdown",
  }
}
