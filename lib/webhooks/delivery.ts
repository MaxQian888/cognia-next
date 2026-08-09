/**
 * Signed webhook delivery with exponential backoff + jitter.
 *
 * The body is serialized ONCE and the exact same bytes are both signed and
 * sent — re-serializing per attempt would risk a signature/body mismatch. The
 * `webhook-id` is held constant across retries so receivers can dedupe.
 */

import { buildSignedHeaders } from "./signing"
import {
  DEFAULT_WEBHOOK_DELIVERY,
  normalizeWebhookDelivery,
  type OutboundWebhookEvent,
  type WebhookDeliveryConfig,
  type WebhookEndpoint,
} from "@/types/webhooks"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

export interface DeliverInput {
  endpoint: WebhookEndpoint
  event: OutboundWebhookEvent
  /** Resolved Standard Webhooks signing secret. Omitted → unsigned delivery. */
  signingSecret?: string
  /**
   * User-tunable retry / timeout / backoff limits. Clamped to the accepted
   * bounds before use; omitted → {@link DEFAULT_WEBHOOK_DELIVERY}.
   */
  limits?: Partial<WebhookDeliveryConfig>
}

export interface DeliverResult {
  ok: boolean
  httpStatus?: number
  error?: string
}

/** Merge header layers case-insensitively; later layers win. */
export function mergeWebhookHeaders(
  ...layers: WebhookEndpoint["headers"][]
): WebhookEndpoint["headers"] {
  const merged = new Map<string, { name: string; value: string }>()
  for (const layer of layers) {
    for (const header of layer) {
      const name = header.name.trim()
      if (!name || name.toLowerCase() === "content-type") continue
      const key = name.toLowerCase()
      if (merged.has(key)) merged.delete(key)
      merged.set(key, { name, value: header.value })
    }
  }
  return [...merged.values()]
}

/** Real sleep — overridable in tests so retry paths run deterministically. */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function deliverWebhook(
  input: DeliverInput,
  opts: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<DeliverResult> {
  const sleep = opts.sleep ?? realSleep
  const { endpoint, event, signingSecret } = input
  const limits = input.limits ? normalizeWebhookDelivery(input.limits) : DEFAULT_WEBHOOK_DELIVERY
  const { maxRetries, baseDelayMs, timeoutMs } = limits
  const body = JSON.stringify(event) // serialize ONCE
  const timestamp = Math.floor(new Date(event.occurredAt).getTime() / 1000)

  const baseHeaders: Record<string, string> = { "content-type": "application/json" }
  for (const h of mergeWebhookHeaders(endpoint.headers)) {
    baseHeaders[h.name] = h.value
  }
  if (signingSecret) {
    Object.assign(baseHeaders, await buildSignedHeaders(event.id, timestamp, body, signingSecret))
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: baseHeaders,
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok) return { ok: true, httpStatus: res.status }
      if (attempt === maxRetries) {
        return { ok: false, httpStatus: res.status, error: `http ${res.status}` }
      }
    } catch (error) {
      clearTimeout(timer)
      if (attempt === maxRetries) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const delay = baseDelayMs * 2 ** attempt + Math.random() * 500
    log.warn(
      `webhook delivery attempt ${attempt + 1} failed for ${endpoint.url}, retrying in ${Math.round(delay)}ms`
    )
    await sleep(delay)
  }
  return { ok: false, error: "exhausted retries" }
}
