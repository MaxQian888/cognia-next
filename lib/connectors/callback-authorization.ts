/**
 * Unified callback authorization guard (plan 2026-07-24 Phase 2).
 *
 * One decision layer in front of EVERY connector-callback consumer — the
 * Execution Run control short-circuit, wf_approve / wf_cancel /
 * wf_fanout_* / tool_approve / skill_invoke / help_quick_command, and the
 * generic A2UI bridge hand-off. Before this guard, the workflow/tool/skill
 * short-circuits executed on binding presence alone: anyone who could SEE a
 * card in a group could approve someone else's workflow or tool call. Card
 * visibility is not permission.
 *
 * Trust model: `event.user` comes from the transport-verified platform
 * envelope (Rust-side signature/decrypt/replay checks), so actor identity is
 * trusted; everything else (binding scope, conversation match, expiry,
 * consume-once, allowed actions, principal registry) is enforced here.
 *
 * Modes (`larkStrictCallbackAuthorization` flag):
 *   - "off"     → legacy bit-for-bit behavior, decision is always allow.
 *   - "audit"   → all checks run; would-deny outcomes are AUDITED by the
 *                 caller but the callback still executes (shadow mode, the
 *                 default — its growth curve is the gray-release signal).
 *   - "enforce" → denials block execution and consume-once is enforced.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingKind,
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import { parseConversationKey } from "@/types/connectors/event"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { getDb } from "@/lib/db/schema"
import { getLarkStrictCallbackAuthorizationMode } from "./feature-flags"
import { hashOpenId, resolveConnectorPrincipal } from "./principal/resolve"

export type CallbackDenyReason =
  | "principal_unbound"
  | "principal_disabled"
  | "tenant_disabled"
  | "cross_account"
  | "adapter_mismatch"
  | "conversation_mismatch"
  | "binding_expired"
  | "binding_consumed"
  | "action_not_allowed"
  | "actor_forbidden"
  | "run_conversation_mismatch"

export type CallbackKindClass = "run_control" | "generic" | ConnectorCallbackBindingKind

export type CallbackAuthorizationMode = "off" | "audit" | "enforce"

export interface AuthorizeCallbackInput {
  event: ConnectorCallbackEvent
  binding?: ConnectorCallbackBindingRow
  adapterRow: AdapterInstanceRow | undefined
  resolvedConversationKey: string | null
  kindClass: CallbackKindClass
  /** For kindClass "run_control": the self-describing payload runId. */
  runId?: string
  now?: number
}

export type AuthorizeCallbackDecision =
  | {
      allowed: true
      mode: CallbackAuthorizationMode
      /** Present for consume-once kinds in enforce mode; call before dispatch. */
      consume?: () => Promise<void>
    }
  | {
      allowed: false
      mode: "audit" | "enforce"
      reason: CallbackDenyReason
      /** Audit-safe fields: actor hash + scope facts, never payloads/tokens. */
      auditFields: Record<string, unknown>
    }

/** Kinds whose binding must activate at most once. */
const CONSUME_ONCE_KINDS = new Set<ConnectorCallbackBindingKind>([
  "wf_approve",
  "wf_cancel",
  "wf_fanout_approve",
  "wf_fanout_cancel",
  "tool_approve",
  "skill_invoke",
])

/**
 * The user-controlled action signal of the click, normalized so
 * `allowedActions` can be checked against it. Empty when the platform event
 * carries no explicit value (the check is skipped then — actor scope is the
 * primary protection; this one hardens against value tampering).
 */
export function normalizeRequestedAction(event: ConnectorCallbackEvent): string {
  const payloadAction = typeof event.payload?.action === "string" ? event.payload.action : ""
  const raw = payloadAction || event.value || ""
  const lowered = raw.toLowerCase()
  if (lowered === "dismiss" || event.actionType === "dismiss") return "cancel"
  return lowered
}

function operatorIdsOf(adapterRow: AdapterInstanceRow | undefined): string[] {
  const configured = adapterRow?.settings.runOperatorUserIds
  return Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === "string")
    : []
}

function actorIdOf(event: ConnectorCallbackEvent): string {
  return event.user.remoteUserId || event.user.id
}

interface ParsedKeyParts {
  platform: string
  adapterId: string
  remoteChatId: string
  threadId?: string
}

function tryParseKey(key: string): ParsedKeyParts | null {
  try {
    return parseConversationKey(key)
  } catch {
    return null
  }
}

/**
 * Chat-level conversation match. Lark card callbacks are chat-scoped (no
 * thread suffix) while bindings written inside a topic carry one — so the
 * threadId only participates when BOTH sides have it.
 */
function conversationMatches(bindingKey: string, eventKey: string): boolean {
  if (bindingKey === eventKey) return true
  const a = tryParseKey(bindingKey)
  const b = tryParseKey(eventKey)
  if (!a || !b) return false
  if (a.platform !== b.platform || a.adapterId !== b.adapterId) return false
  if (a.remoteChatId !== b.remoteChatId) return false
  if (a.threadId && b.threadId && a.threadId !== b.threadId) return false
  return true
}

/**
 * Deterministic actor scope for rows written before this guard existed.
 * wf_approve/wf_cancel payloads already carry the triggering initiator, so
 * they get real initiator scoping; every other legacy kind falls back to
 * conversation scope — the pre-guard behavior — and ages out with the
 * 30-day binding TTL. help/welcome surfaces are anyone-clickable by design.
 */
function legacyActorScope(binding: ConnectorCallbackBindingRow): CallbackActorScope {
  if (binding.kind === "wf_approve" || binding.kind === "wf_cancel") {
    const initiator = (
      binding.payload?.triggeredFrom as { initiator?: { remoteUserId?: string } } | undefined
    )?.initiator?.remoteUserId
    if (typeof initiator === "string" && initiator.length > 0) {
      return { mode: "initiator", allowedUserIds: [initiator] }
    }
  }
  if (binding.kind === "help_quick_command") return { mode: "anyone" }
  return { mode: "conversation" }
}

function actorScopeSatisfied(
  scope: CallbackActorScope,
  actorId: string,
  operatorIds: string[],
  conversationMatched: boolean
): boolean {
  switch (scope.mode) {
    case "anyone":
      return true
    case "conversation":
      return conversationMatched
    case "initiator":
    case "operators": {
      const allowed = new Set([...(scope.allowedUserIds ?? []), ...operatorIds])
      return allowed.has(actorId)
    }
  }
}

export async function authorizeConnectorCallback(
  input: AuthorizeCallbackInput
): Promise<AuthorizeCallbackDecision> {
  const mode = getLarkStrictCallbackAuthorizationMode(input.adapterRow)
  if (mode === "off") return { allowed: true, mode }

  const now = input.now ?? Date.now()
  const { event, binding } = input
  const actorId = actorIdOf(event)
  const baseFields = async (): Promise<Record<string, unknown>> => ({
    actorHash: await hashOpenId(actorId),
    kindClass: input.kindClass,
    ...(binding ? { bindingId: binding.id } : {}),
    ...(binding?.actorScope ? {} : binding ? { legacyActorScope: true } : {}),
  })
  const deny = async (reason: CallbackDenyReason): Promise<AuthorizeCallbackDecision> => ({
    allowed: false,
    mode,
    reason,
    auditFields: await baseFields(),
  })

  // 1. Adapter match (defense in depth — the [adapterId+actionId] lookup
  //    already implies it for bindings resolved by this bus instance).
  if (binding && binding.adapterId !== event.adapterId) return deny("adapter_mismatch")

  // 2. Expiry re-check: resolveCallbackBinding enforces it at read time, but
  //    a caller passing a stale row must not bypass the guard.
  if (binding?.expiresAt !== undefined && binding.expiresAt <= now) {
    return deny("binding_expired")
  }

  // 3. Consume-once: a stale re-click of an already-activated approval /
  //    skill confirmation is an idempotent deny, closing the real gap where
  //    a second "Allow for session" click silently re-granted the bypass.
  if (binding && CONSUME_ONCE_KINDS.has(binding.kind) && binding.consumedAt !== undefined) {
    return deny("binding_consumed")
  }

  // 4. Conversation match (only when both sides carry a key).
  const conversationMatched =
    binding?.conversationKey && event.conversationKey
      ? conversationMatches(binding.conversationKey, event.conversationKey)
      : true
  if (!conversationMatched) return deny("conversation_mismatch")

  // 5. Principal registry (Lark + larkPrincipalRegistry on; otherwise the
  //    resolver reports "legacy" and the check is skipped).
  const principalResolution = await resolveConnectorPrincipal({
    platform: event.platform,
    adapterRow: input.adapterRow ?? { settings: {} },
    remoteUserId: actorId,
    identityScope: event.identityScope,
  })
  if (principalResolution.status !== "legacy" && principalResolution.status !== "resolved") {
    const reason: CallbackDenyReason =
      principalResolution.status === "unbound"
        ? "principal_unbound"
        : principalResolution.status === "principal_disabled"
          ? "principal_disabled"
          : principalResolution.status === "tenant_disabled"
            ? "tenant_disabled"
            : "cross_account"
    return deny(reason)
  }

  // 6. Allowed actions (only when the binding declares them AND the event
  //    carries an explicit action signal).
  const requestedAction = normalizeRequestedAction(event)
  if (
    binding?.allowedActions &&
    requestedAction &&
    !binding.allowedActions.includes(requestedAction)
  ) {
    return deny("action_not_allowed")
  }

  // 7. Actor scope.
  if (binding) {
    const scope = binding.actorScope ?? legacyActorScope(binding)
    const operatorIds = operatorIdsOf(input.adapterRow)
    if (!actorScopeSatisfied(scope, actorId, operatorIds, conversationMatched)) {
      return deny("actor_forbidden")
    }
  }

  // 8. run_control extra: the callback's conversation must actually be bound
  //    to the run it claims to control. Initiator/operator/revision checks
  //    stay delegated to `executeRunControlCommand` — no duplication here.
  if (input.kindClass === "run_control" && input.runId && event.conversationKey) {
    const bindings = await getDb()
      .executionRunBindings.where("conversationKey")
      .equals(event.conversationKey)
      .toArray()
    const bound = bindings.some(
      (row) => row.runId === input.runId && row.adapterId === event.adapterId
    )
    if (!bound) return deny("run_conversation_mismatch")
  }

  const decision: AuthorizeCallbackDecision = { allowed: true, mode }
  if (mode === "enforce" && binding && CONSUME_ONCE_KINDS.has(binding.kind)) {
    decision.consume = async () => {
      await getDb().connectorCallbackBindings.update(binding.id, { consumedAt: now })
    }
  }
  return decision
}

/**
 * Throttled bilingual denial notice for actor_forbidden in enforce mode —
 * the clicker gets one explanation instead of a silently dead button, and
 * the outbound idempotency key caps redelivery storms to one notice.
 */
export async function notifyCallbackDenied(
  event: ConnectorCallbackEvent,
  conversationKey: string,
  overrides: { enqueue?: typeof enqueueOutbound } = {}
): Promise<void> {
  const enqueue = overrides.enqueue ?? enqueueOutbound
  const text = [
    "You are not authorized to act on this card — only the requester or a configured operator can.",
    "你没有权限操作此卡片——仅发起人或已配置的操作员可以。",
  ].join("\n")
  const parsed = tryParseKey(conversationKey)
  await enqueue({
    adapterId: event.adapterId,
    conversationKey,
    request: {
      conversationRef: {
        platform: event.platform,
        adapterId: event.adapterId,
        channelId: parsed?.remoteChatId ?? conversationKey,
        ...(parsed?.threadId ? { threadTs: parsed.threadId } : {}),
      },
      segments: [{ type: "text", text }],
      metadata: { idempotencyKey: `cb-denied:${event.triggerId}` },
    },
    source: "ai-run",
  }).catch(() => undefined)
}
