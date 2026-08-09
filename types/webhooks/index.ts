/** Canonical Standard Webhooks configuration and delivery contracts. */

export interface WebhookHeader {
  name: string
  value: string
}

export interface WebhookEndpoint {
  id: string
  name: string
  url: string
  headers: WebhookHeader[]
  enabled: boolean
  /** Empty or absent means the endpoint receives every event. */
  eventTypes?: string[]
}

export interface WebhookDeliveryConfig {
  maxRetries: number
  timeoutMs: number
  baseDelayMs: number
}

export interface WebhookConfig {
  hasSigningSecret: boolean
  defaultHeaders: WebhookHeader[]
  endpoints: WebhookEndpoint[]
  delivery?: WebhookDeliveryConfig
}

export const DEFAULT_WEBHOOK_DELIVERY: WebhookDeliveryConfig = {
  maxRetries: 3,
  timeoutMs: 10_000,
  baseDelayMs: 1000,
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  hasSigningSecret: false,
  defaultHeaders: [],
  endpoints: [],
  delivery: { ...DEFAULT_WEBHOOK_DELIVERY },
}

export const WEBHOOK_DELIVERY_BOUNDS = {
  maxRetries: { min: 0, max: 10 },
  timeoutMs: { min: 1000, max: 120_000 },
  baseDelayMs: { min: 100, max: 60_000 },
} as const

/** Clamp delivery limits into the supported range and fill defaults. */
export function normalizeWebhookDelivery(
  partial?: Partial<WebhookDeliveryConfig>
): WebhookDeliveryConfig {
  const clamp = (value: number, min: number, max: number, fallback: number): number => {
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  const bounds = WEBHOOK_DELIVERY_BOUNDS
  return {
    maxRetries: clamp(
      partial?.maxRetries ?? DEFAULT_WEBHOOK_DELIVERY.maxRetries,
      bounds.maxRetries.min,
      bounds.maxRetries.max,
      DEFAULT_WEBHOOK_DELIVERY.maxRetries
    ),
    timeoutMs: clamp(
      partial?.timeoutMs ?? DEFAULT_WEBHOOK_DELIVERY.timeoutMs,
      bounds.timeoutMs.min,
      bounds.timeoutMs.max,
      DEFAULT_WEBHOOK_DELIVERY.timeoutMs
    ),
    baseDelayMs: clamp(
      partial?.baseDelayMs ?? DEFAULT_WEBHOOK_DELIVERY.baseDelayMs,
      bounds.baseDelayMs.min,
      bounds.baseDelayMs.max,
      DEFAULT_WEBHOOK_DELIVERY.baseDelayMs
    ),
  }
}

export const OUTBOUND_EVENT_TYPES: readonly string[] = [
  "start",
  "progress",
  "complete",
  "error",
  "auto-paused",
] as const

export function endpointSubscribesTo(endpoint: WebhookEndpoint, eventType: string): boolean {
  const subscriptions = endpoint.eventTypes
  return !subscriptions || subscriptions.length === 0 || subscriptions.includes(eventType)
}

export type WebhookSignatureScheme = "standard-webhooks"

export interface OutboundWebhookEvent {
  id: string
  eventType: string
  source: string
  payload: Record<string, unknown>
  occurredAt: string
}

export interface WebhookAuditEntry {
  id: string
  at: number
  direction: "outbound"
  kind: "outbound.delivered" | "outbound.failed"
  result: "delivered" | "failed"
  endpointId?: string
  httpStatus?: number
  fields?: Record<string, unknown>
}
