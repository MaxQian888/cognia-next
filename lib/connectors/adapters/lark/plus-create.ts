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

/** Minimal synthetic event carrying just what session binding reads. */
function sessionSeed(adapterId: string, chatId: string): NormalizedInboundEvent {
  const conversationKey = buildConversationKey("lark", adapterId, chatId)
  return {
    platform: "lark",
    adapterId,
    selfId: "",
    messageId: `lark.plus:${chatId}`,
    conversationRef: { platform: "lark", adapterId, channelId: chatId },
    conversationKey,
    sender: {
      id: `lark:${chatId}`,
      platform: "lark",
      adapterId,
      remoteUserId: chatId,
      displayName: undefined,
      avatarUrl: undefined,
    },
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

  const adapterRow = await deps.getAdapter(input.adapterId).catch(() => undefined)
  if (!isLarkFeatureEnabled("larkPlusMenu", adapterRow))
    return { ok: false, error: "feature_disabled" }
  if (!input.chatId) return { ok: false, error: "chat_missing" }

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
    return { ok: false, error: `principal_${resolution.status}` }
  }

  try {
    if (!(await deps.isMember(input.adapterId, input.chatId, input.verifiedIdentity.openId))) {
      return { ok: false, error: "membership_denied" }
    }
  } catch {
    return { ok: false, error: "membership_check_failed" }
  }

  const session = await createPlatformSession(sessionSeed(input.adapterId, input.chatId), undefined)
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
