export type AuditKind =
  | "delivery.success"
  | "delivery.error"
  | "delivery.deadlettered"
  | "delivery.downgraded"
  | "inbound.received"
  | "inbound.deduped"
  | "inbound.policy_blocked"
  | "inbound.signature_failed"
  | "circuit.opened"
  | "circuit.half_opened"
  | "circuit.closed"
  | "rate_limit.tripped"
  | "credential.refreshed"
  | "adapter.started"
  | "adapter.stopped"
  | "adapter.error"

export interface AuditEntry {
  id: string
  adapterId: string
  kind: AuditKind
  at: number
  conversationKey?: string
  idempotencyKey?: string
  reason?: string
  message?: string
  /** Free-form structured payload; redaction-aware logger writes this. */
  fields?: Record<string, unknown>
}

export interface DeliveryErrorInput {
  adapterId: string
  conversationKey: string
  idempotencyKey: string
  reason: string
  message: string
  fields?: Record<string, unknown>
}

export function auditDeliveryError(input: DeliveryErrorInput): AuditEntry {
  return {
    id: crypto.randomUUID(),
    adapterId: input.adapterId,
    kind: "delivery.error",
    at: Date.now(),
    conversationKey: input.conversationKey,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    message: input.message,
    fields: input.fields,
  }
}
