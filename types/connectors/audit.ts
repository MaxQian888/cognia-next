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
  // Cross-provider help / welcome card subsystem (lib/connectors/help). The
  // bus served an on-demand help card in response to a help-trigger message
  // (`inbound.help_served`) or pushed a proactive welcome card on bot-join /
  // first-inbound (`inbound.welcome_sent`). Both short-circuit the AI turn.
  | "inbound.help_served"
  | "inbound.welcome_sent"
  | "outbound.enqueued"
  | "outbound.ai_run_enqueued"
  // outboundQueue soft cap (5000) tripped — `enqueueOutbound` aged the
  // oldest pending row to `deadlettered`. Carries `fields.jobId`,
  // `fields.ageMs`, `fields.createdAt`, `fields.source`. Drives the
  // Inbox `OutboundSaturationBanner` (>100 capped rows in 24h →
  // visible banner).
  | "outbound.queue_capped"
  // Callback binding expired and was reaped from
  // `connectorCallbackBindings`. Per-row audit so "the button stopped
  // working" tickets can find the actionId + conversationKey that
  // dropped off. Emitted from `callback-binding-cleanup.ts` inside the
  // existing daily prune sweep.
  | "callback.binding_expired"
  // /goal command targeted an IM-bound conversation. Two flavors:
  // `goal.blocked.im` — no `allowGoalDriving` override; `goal.started.im`
  // — opt-in granted. Either way the IM audit lets the operator see
  // self-driving goals running in inbox sessions.
  | "goal.started.im"
  | "goal.blocked.im"
  | "circuit.opened"
  | "circuit.half_opened"
  | "circuit.closed"
  | "rate_limit.tripped"
  | "credential.refreshed"
  | "adapter.started"
  | "adapter.stopped"
  | "adapter.error"
  // Settings rotated the adapter's credentials and lifecycle re-queued
  // the running entry without a full app restart. Carries `fields.via`
  // ("settings_save" | "manual_requeue") so operators can tell the two
  // apart in the Audit tab.
  | "adapter.credentials_rotated"
  // Per-conversation Computer Use opt-in toggled from Inbox header
  // (ADR-0020). Fields carry `{ allowComputerUse: boolean, bioVerified:
  // boolean, via: string }` so the audit log shows whether the flip went
  // through a hardened confirmation step or a plain checkbox.
  | "override.computer_use_changed"
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
  // Workflow Approve / Cancel A2UI callback path failed before
  // `handleWorkflowApprovalCallback` could finish (binding read,
  // orchestrator start, or sibling-binding delete threw). Audited
  // exactly once per dispatched callback so the operator can see why
  // the in-chat surface didn't progress past the tap.
  | "workflow_approval_failed"
  // Workflow fan-out subscription Approve / Cancel A2UI callback failed
  // (binding decode, Dexie write, or sibling-binding cleanup threw).
  // Same shape contract as `workflow_approval_failed`.
  | "workflow_fanout_failed"
  // In-chat control commands (control-plane completion). `command.applied`
  // when a `/model` / `/mode` / `/new` / … mutated state and a confirmation
  // was sent; `command.denied` when the permission gate rejected a
  // state-changing command; `command.unknown` for an unrecognised `/…`.
  | "command.applied"
  | "command.denied"
  | "command.unknown"
  // Agent Team dispatch from an inbound IM message (control-plane multi-agent).
  // Fired when `overrideRow.teamId` routed the turn to `runTeamLifecycle`
  // instead of the single-character `runAndCapture` path.
  | "team.dispatched"
  // Visual Workflow dispatch from an inbound IM message (workflow⇄IM parity).
  // Fired when `overrideRow.workflowId` routed the turn to `startWorkflowFromIM`
  // (`lib/workflow/runtime/start-from-im.ts`) instead of the single-character
  // `runAndCapture` path. Mirrors `team.dispatched`; `teamId` wins when both are
  // set. Carries `fields.workflowId` + `fields.sourceMessageId`.
  | "workflow.dispatched"
  // Tool-permission approval over chat (control-plane HITL). `requested` when
  // an ask-tier tool projected an Allow/Deny card; `granted` / `denied` on the
  // user's button press; `expired` when the approval TTL elapsed (auto-deny).
  | "tool_approve.requested"
  | "tool_approve.granted"
  | "tool_approve.denied"
  | "tool_approve.expired"
  // Proactive notification over IM (control-plane notifications). `pushed` when
  // an agent event was enqueued to a conversation; `skipped` when opt-in was
  // off / no target resolved; `pii_blocked` when the PII gate dropped it.
  | "notify.im_pushed"
  | "notify.im_skipped"
  | "notify.im_pii_blocked"
  // Live in-turn activity card (control-plane visibility — cc-connect-style
  // "the agent is working" live card). `card_dispatched` when the cumulative
  // activity card's first frame is enqueued; `card_finalized` when the card
  // transitions to its terminal Done/Failed state at turn end; `edit_fallback`
  // when an edit-frame fell back to a fresh send because the entry card's
  // platformMessageId hadn't landed yet. Emitted from
  // `lib/connectors/activity/turn-activity-dispatcher.ts`.
  | "activity.card_dispatched"
  | "activity.card_finalized"
  | "activity.edit_fallback"
  // APPEND-mode live activity (adapters without `edit()` — one compact line per
  // throttled boundary instead of full suppression). `card_appended` carries
  // `fields.appendCount` so an operator can see progress lines accruing.
  | "activity.card_appended"
  // Dead-lettered outbound job manually replayed from the Inbox/Settings DLQ
  // panel — resets the row and re-arms the outbound runner. Carries the
  // original error code in `fields.lastErrorCode`. Emitted from the replay
  // UI path (`lib/db/outbound-jobs.ts` replayDeadlettered callers).
  | "outbound.replayed"
  // Inbound OCR step failed (best-effort, never blocks delivery). Emitted
  // from `lib/connectors/inbound-ocr.ts` so a silently-dropped image's OCR
  // failure is traceable instead of invisible. Carries the error in `message`.
  | "inbound.ocr_failed"
  // Plugin connector hooks (plugin⇄IM extensibility). A plugin's
  // `onConnectorInbound` / `onConnectorOutbound` returned a decision:
  // `*_blocked` when it vetoed the message (turn stopped / job dropped),
  // `*_transformed` when it rewrote the segments (and the rewrite PASSED the
  // PII re-gate). `transform_pii_blocked` when a transform was REJECTED because
  // it would have leaked PII (the original is kept). Carries `fields.pluginId`
  // when known + `reason`.
  | "plugin.inbound_blocked"
  | "plugin.inbound_transformed"
  | "plugin.outbound_blocked"
  | "plugin.outbound_transformed"
  | "plugin.transform_pii_blocked"
  // A plugin `im-rate-source` (`lib/connectors/im-rate/registry.ts`) returned a
  // block decision for this conversation, so the connector runtime suppressed
  // the AI-run turn before building the send. Carries `reason` + `fields.key`
  // (the source key). Advisory/additive — only further restricts the policy.
  | "plugin.rate_blocked"

export interface AuditEntry {
  id: string
  adapterId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86). Routing/audit data is per-project. */
  projectId?: string
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
