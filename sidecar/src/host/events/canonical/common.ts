export type { CanonicalEvent } from "../../../shared/wire/outbound.ts"

export interface SdkMappingState {
  sawStreamEvents: boolean
  activeStreamMessageId?: string
  streamedMessageIds?: Set<string>
  emittedToolCallIds?: Set<string>
  expectStructuredOutput?: boolean
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export const asString = (v: unknown) => (typeof v === "string" ? v : undefined)

export const asNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

/** Drop undefined values so envelopes stay stable across emitters. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out as T
}
