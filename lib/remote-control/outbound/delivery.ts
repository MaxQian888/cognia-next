/**
 * Signed webhook delivery with exponential backoff + jitter.
 *
 * The body is serialized ONCE and the exact same bytes are both signed and
 * sent — re-serializing per attempt would risk a signature/body mismatch. The
 * `webhook-id` is held constant across retries so receivers can dedupe.
 */

import { buildSignedHeaders } from "./signing"
import type { OutboundWebhookEvent, WebhookEgressEndpoint } from "@/types/remote-control"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler
const MAX_RETRIES = 3
const BASE_DELAY = 1000
const TIMEOUT_MS = 10_000

export interface DeliverInput {
  endpoint: WebhookEgressEndpoint
  event: OutboundWebhookEvent
  /** Resolved Standard Webhooks signing secret. Omitted → unsigned delivery. */
  signingSecret?: string
}

export interface DeliverResult {
  ok: boolean
  httpStatus?: number
  error?: string
}

/** Real sleep — overridable in tests so retry paths run deterministically. */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function deliverWebhook(
  input: DeliverInput,
  opts: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<DeliverResult> {
  const sleep = opts.sleep ?? realSleep
  const { endpoint, event, signingSecret } = input
  const body = JSON.stringify(event) // serialize ONCE
  const timestamp = Math.floor(new Date(event.occurredAt).getTime() / 1000)

  const baseHeaders: Record<string, string> = { "content-type": "application/json" }
  for (const h of endpoint.headers) {
    const name = h.name.trim()
    if (name) baseHeaders[name] = h.value
  }
  if (signingSecret) {
    Object.assign(baseHeaders, await buildSignedHeaders(event.id, timestamp, body, signingSecret))
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: baseHeaders,
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok) return { ok: true, httpStatus: res.status }
      if (attempt === MAX_RETRIES) {
        return { ok: false, httpStatus: res.status, error: `http ${res.status}` }
      }
    } catch (error) {
      clearTimeout(timer)
      if (attempt === MAX_RETRIES) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const delay = BASE_DELAY * 2 ** attempt + Math.random() * 500
    log.warn(
      `webhook delivery attempt ${attempt + 1} failed for ${endpoint.url}, retrying in ${Math.round(delay)}ms`
    )
    await sleep(delay)
  }
  return { ok: false, error: "exhausted retries" }
}
