export type AuditKind =
  | "delivery.success"
  | "delivery.error"
  | "delivery.deadlettered"
  | "delivery.downgraded"
  | "inbound.received"
  | "inbound.deduped"
  | "inbound.policy_blocked"
  | "inbound.signature_failed"
  | "inbound.edited"
  | "inbound.deleted"
  | "inbound.read_indicator"
  | "inbound.member_added"
  | "inbound.member_removed"
  | "inbound.deferred_quiet_hours"
  | "inbound.deferred_muted"
  | "inbound.deferred_manual_mode"
  | "outbound.enqueued"
  | "outbound.ai_run_enqueued"
  | "circuit.opened"
  | "circuit.half_opened"
  | "circuit.closed"
  | "rate_limit.tripped"
  | "credential.refreshed"
  | "adapter.started"
  | "adapter.stopped"
  | "adapter.error"
  // Periodic heartbeat probe (v45) so the per-adapter Health view can
  // colour 24h dot grids on intervals where nothing else fired. Pruned
  // by the heartbeat writer itself — see
  // `lib/connectors/health/heartbeat.ts`. The default Audit-tab kind
  // filter excludes this kind because it's noisy by design.
  | "adapter.heartbeat"
  // ── Connector callback channel (G4) ──────────────────────────────────
  | "callback.received"
  | "callback.deduped"
  | "callback.unbound"
  | "callback.handler_failed"
  // ── Built-in skills tier (ADR-0026 / schema v43) ─────────────────────
  // The dispatcher emits one of these on every `runBuiltInSkill` call.
  // `reason` carries the gate that fired (`pii_blocked`,
  // `mutation_blocked`, `not_allowed_for_channel`, etc.) and `fields`
  // carries `{skillId, mutation, hitl}`. PII redaction runs against
  // `fields.args` before the row is written.
  | "builtin_skill_invoked"
  | "builtin_skill_denied"
  | "builtin_skill_hitl_pending"
  | "builtin_skill_hitl_approved"
  | "builtin_skill_hitl_rejected"
  | "builtin_skill_failed"

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
