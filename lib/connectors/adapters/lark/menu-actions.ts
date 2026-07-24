/**
 * Terminal handling for bot-menu outcomes that must not reach the model
 * (plan 2026-07-24 P4.2): `unknown` event_keys get a fixed bilingual notice
 * plus a `menu.unknown_key` audit, and `link` commands reply with a URL
 * resolved against the configured web entry base.
 *
 * Both replies address the operator's p2p chat by open_id (the menu event
 * carries no chat_id) and are deduped per event_id via the outbound
 * idempotency key, so transport redeliveries never double-post.
 */

import type { LarkFlagAdapterSettings } from "@/lib/connectors/feature-flags"
import { appendAudit } from "@/lib/connectors/audit"
import { resolveWebEntryBase } from "@/lib/connectors/entry/deep-links"
import { hashOpenId } from "@/lib/connectors/principal/resolve"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import type { LarkBotMenuOutcome } from "./parse"

export interface MenuActionDependencies {
  enqueue: typeof enqueueOutbound
  audit: typeof appendAudit
  now: () => number
}

function withDefaults(overrides: Partial<MenuActionDependencies>): MenuActionDependencies {
  return { enqueue: enqueueOutbound, audit: appendAudit, now: Date.now, ...overrides }
}

/** Bilingual IM literals (follow-up-control convention — not next-intl). */
const UNKNOWN_KEY_REPLY = [
  "This menu action isn't configured yet. Ask your administrator to map it in Cognia → Settings → Connections.",
  "该菜单项尚未配置。请联系管理员在 Cognia → 设置 → 连接 中完成映射。",
].join("\n")

const LINK_BASE_MISSING_REPLY = [
  "The Cognia web entry isn't configured for this workspace yet, so this menu can't open a link.",
  "当前工作区尚未配置 Cognia Web 入口，此菜单暂时无法打开链接。",
].join("\n")

function p2pReply(
  adapterId: string,
  openId: string,
  eventId: string,
  slot: string,
  text: string
): Parameters<typeof enqueueOutbound>[0] {
  return {
    adapterId,
    conversationKey: `lark:${adapterId}:${openId}`,
    request: {
      conversationRef: { platform: "lark", adapterId, channelId: openId },
      segments: [{ type: "text", text }],
      metadata: { idempotencyKey: `${slot}:${adapterId}:${eventId}` },
    },
    source: "ai-run",
  }
}

/**
 * Unknown event_key → audit (open_id only as a hash) + fixed notice.
 * Deliberately NOT throttled per-day like the unbound notice: each distinct
 * click is one distinct misconfiguration signal, and event_id dedup already
 * absorbs redeliveries.
 */
export async function handleMenuUnknownKey(
  adapterId: string,
  outcome: Extract<LarkBotMenuOutcome, { kind: "unknown" }>,
  overrides: Partial<MenuActionDependencies> = {}
): Promise<void> {
  const deps = withDefaults(overrides)
  const now = deps.now()
  await deps.audit({
    adapterId,
    kind: "menu.unknown_key",
    at: now,
    conversationKey: `lark:${adapterId}:${outcome.openId}`,
    reason: "unmapped_event_key",
    fields: {
      eventKey: outcome.eventKey,
      openIdHash: await hashOpenId(outcome.openId),
      ...(outcome.identityScope?.tenantKey ? { tenantKey: outcome.identityScope.tenantKey } : {}),
    },
  })
  await deps.enqueue(
    p2pReply(adapterId, outcome.openId, outcome.eventId, "menu-unknown", UNKNOWN_KEY_REPLY)
  )
}

/**
 * Link command → reply with the app URL under the configured web entry base.
 * The reserved batch links only to app paths (workbench), which carry no
 * key material — conversation-targeted links go through the authorized
 * entry-token builders instead. No base configured → explanatory notice
 * (never a raw internal URL).
 */
export async function handleMenuLink(
  adapterId: string,
  adapterRow: LarkFlagAdapterSettings | undefined,
  outcome: Extract<LarkBotMenuOutcome, { kind: "link" }>,
  overrides: Partial<MenuActionDependencies> = {}
): Promise<void> {
  const deps = withDefaults(overrides)
  const base = resolveWebEntryBase(adapterRow)
  const path = outcome.command.action.value
  const text = base
    ? `${outcome.command.label ?? path}\n${base}${path === "/" ? "" : path}`
    : LINK_BASE_MISSING_REPLY
  await deps.enqueue(p2pReply(adapterId, outcome.openId, outcome.eventId, "menu-link", text))
}
