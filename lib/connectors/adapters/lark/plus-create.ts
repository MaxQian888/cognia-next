/**
 * `+`-menu "new task" intent (plan 2026-07-24 P5.2).
 *
 * Opened from a chat's input-box `+` menu, our web app posts a create
 * intent with the verified SSO identity; the brain gates it (flag +
 * principal + chat membership), then binds a fresh session to the chat's
 * conversation — reusing the exact session-binding machinery the inbound
 * pipeline uses, so `/new`-style multi-session semantics hold. Intent
 * only: no message is written and no model turn runs.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import { appendAudit } from "@/lib/connectors/audit"
import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { recordConnectorMetric } from "@/lib/connectors/metrics"
import { stampConnectorConversationPrincipal } from "@/lib/db/connector-conversation-state"
import {
  getActiveRuntimeAccountId,
  hashOpenId,
  resolveConnectorPrincipal,
} from "@/lib/connectors/principal/resolve"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { createPlatformSession } from "@/lib/connectors/session-bindings"

export interface PlusCreateInput {
  adapterId: string
  chatId?: string
  verifiedIdentity: { openId: string; tenantKey?: string; appId?: string }
}

export type PlusCreateOutcome =
  { ok: true; conversationKey: string; sessionId: string } | { ok: false; error: string }

export interface PlusCreateDependencies {
  getAdapter: typeof getAdapterInstance
  isMember: (adapterId: string, chatId: string, openId: string) => Promise<boolean>
  audit: typeof appendAudit
  now: () => number
}

/**
 * Minimal synthetic event carrying just what session binding reads.
 *
 * The sender is the SSO-verified `open_id` of the person who tapped `+`, not
 * the chat id: the session's initiator is a real principal, and attributing it
 * to the chat would make the resulting run un-authorizable (no actor to match
 * against `initiator` scope) and mis-attribute it in the audit trail.
 */
export function sessionSeed(
  adapterId: string,
  chatId: string,
  openId: string
): NormalizedInboundEvent {
  const conversationKey = buildConversationKey("lark", adapterId, chatId)
  return {
    platform: "lark",
    adapterId,
    selfId: "",
    messageId: `lark.plus:${chatId}`,
    conversationRef: { platform: "lark", adapterId, channelId: chatId },
    conversationKey,
    sender: {
      id: `lark:${openId}`,
      platform: "lark",
      adapterId,
      remoteUserId: openId,
      displayName: undefined,
      avatarUrl: undefined,
    },
    // `group` is the conservative default: Lark p2p and group chats share the
    // `oc_` chat-id shape, so the kind cannot be inferred here, and treating a
    // private chat as a group only applies the stricter group rate limits.
    // The first real inbound event corrects the conversation record.
    channel: { id: conversationKey, kind: "group", platformChannelId: chatId },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    kind: "create",
  }
}

export async function handlePlusCreate(
  input: PlusCreateInput,
  overrides: Partial<PlusCreateDependencies> = {}
): Promise<PlusCreateOutcome> {
  const deps: PlusCreateDependencies = {
    getAdapter: getAdapterInstance,
    isMember: () => Promise.reject(new Error("isMember dependency not wired")),
    audit: appendAudit,
    now: Date.now,
    ...overrides,
  }
  const now = deps.now()

  /**
   * Every rejection is audited and counted. The import path already did this;
   * plus-create returned bare codes, so a `+`-menu entry that silently refused
   * every tap (wrong flag, unbound principal, non-member) left no trace at all
   * on the operator side.
   */
  const deny = async (error: string): Promise<PlusCreateOutcome> => {
    recordConnectorMetric("lark_plus_create_denied_total")
    await deps
      .audit({
        adapterId: input.adapterId,
        kind: "plus.create_denied",
        at: now,
        reason: error,
        fields: {
          chatId: input.chatId,
          openIdHash: await hashOpenId(input.verifiedIdentity.openId),
        },
      })
      .catch(() => undefined)
    return { ok: false, error }
  }

  const adapterRow = await deps.getAdapter(input.adapterId).catch(() => undefined)
  if (!isLarkFeatureEnabled("larkPlusMenu", adapterRow)) return deny("feature_disabled")
  if (!input.chatId) return deny("chat_missing")

  const resolution = await resolveConnectorPrincipal({
    platform: "lark",
    adapterRow: adapterRow ?? { settings: {} },
    remoteUserId: input.verifiedIdentity.openId,
    identityScope: {
      tenantKey: input.verifiedIdentity.tenantKey,
      appId: input.verifiedIdentity.appId,
    },
    activeAccountId: getActiveRuntimeAccountId(),
  })
  if (resolution.status !== "resolved" && resolution.status !== "legacy") {
    return deny(`principal_${resolution.status}`)
  }

  try {
    if (!(await deps.isMember(input.adapterId, input.chatId, input.verifiedIdentity.openId))) {
      return deny("membership_denied")
    }
  } catch {
    return deny("membership_check_failed")
  }

  const session = await createPlatformSession(
    sessionSeed(input.adapterId, input.chatId, input.verifiedIdentity.openId),
    undefined
  )
  // Same denormalized stamp the inbound bus applies at Step 2.5. Best-effort:
  // when the conversation record does not exist yet the first real inbound
  // event stamps it, and the registry stays the authority either way.
  if (resolution.status === "resolved" && session.platformConversationKey) {
    await stampConnectorConversationPrincipal(session.platformConversationKey, {
      accountId: resolution.accountId,
      principalId: resolution.principal.id,
    }).catch(() => undefined)
  }
  recordConnectorMetric("lark_plus_create_total")
  await deps
    .audit({
      adapterId: input.adapterId,
      kind: "plus.create",
      at: now,
      conversationKey: session.platformConversationKey,
      fields: {
        chatId: input.chatId,
        openIdHash: await hashOpenId(input.verifiedIdentity.openId),
        sessionId: session.id,
      },
    })
    .catch(() => undefined)
  return {
    ok: true,
    conversationKey: session.platformConversationKey ?? "",
    sessionId: session.id,
  }
}
