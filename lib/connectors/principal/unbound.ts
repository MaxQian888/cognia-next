/**
 * Terminal handling for Lark inbound events whose sender could not be
 * resolved to a registered principal (plan 2026-07-24 Phase 1, §3.2).
 *
 * Fail-closed contract: the durable inbound job is parked as `history_only`
 * (auditable, never executed), an audit row records WHY with the open_id only
 * as a hash, and — for plain `unbound` senders only — a bind request is
 * created and a once-per-day reply tells the user how to get linked.
 * Disabled / cross-account / disabled-tenant senders get no reply and no
 * self-service bind path: silence is the security posture there.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { appendAudit } from "@/lib/connectors/audit"
import { recordConnectorMetric } from "@/lib/connectors/metrics"
import { createBindRequest } from "@/lib/db/feishu-principals"
import { markConnectorInboundJobHistoryOnly } from "@/lib/db/connector-inbound-jobs"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { hashOpenId, type PrincipalResolution } from "./resolve"

export type UnresolvedPrincipalResolution = Exclude<
  PrincipalResolution,
  { status: "legacy" | "resolved" }
>

export interface UnresolvedPrincipalDependencies {
  enqueue: typeof enqueueOutbound
  audit: typeof appendAudit
  bindRequest: typeof createBindRequest
  markHistoryOnly: typeof markConnectorInboundJobHistoryOnly
  now: () => number
}

/** Bilingual IM literal, following the follow-up-control outbound convention. */
function unboundReplyText(bindCode: string): string {
  return [
    `This Feishu account is not linked to Cognia yet. Ask your administrator to approve bind code ${bindCode}.`,
    `该飞书账号尚未关联 Cognia。请联系管理员审批绑定码 ${bindCode}。`,
  ].join("\n")
}

function utcDayStamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10).replaceAll("-", "")
}

export async function handleUnresolvedPrincipal(
  event: NormalizedInboundEvent,
  adapterRow: Pick<AdapterInstanceRow, "id">,
  resolution: UnresolvedPrincipalResolution,
  inboundJobId: string,
  overrides: Partial<UnresolvedPrincipalDependencies> = {}
): Promise<void> {
  const deps: UnresolvedPrincipalDependencies = {
    enqueue: enqueueOutbound,
    audit: appendAudit,
    bindRequest: createBindRequest,
    markHistoryOnly: markConnectorInboundJobHistoryOnly,
    now: Date.now,
    ...overrides,
  }
  const now = deps.now()
  const openIdHash =
    resolution.status === "unbound"
      ? resolution.openIdHash
      : await hashOpenId(event.sender.remoteUserId)

  await deps.markHistoryOnly(inboundJobId, `principal_${resolution.status}`, { now })
  recordConnectorMetric("lark_principal_unbound_total")

  if (resolution.status === "unbound") {
    const request = await deps.bindRequest({
      openId: event.sender.remoteUserId,
      adapterId: event.adapterId,
      tenantKey: resolution.tenantKey,
      appId: resolution.appId,
      conversationKey: event.conversationKey,
      now,
    })
    await deps.audit({
      adapterId: event.adapterId,
      kind: "principal.unbound",
      at: now,
      conversationKey: event.conversationKey,
      reason: "unbound",
      fields: {
        tenantKey: resolution.tenantKey,
        appId: resolution.appId,
        openIdHash,
        bindRequestId: request.id,
      },
    })
    // Outbound idempotency caps the notice at once per sender per UTC day —
    // repeated messages from the same unbound user stay silent until tomorrow.
    await deps.enqueue({
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      request: {
        conversationRef: event.conversationRef,
        segments: [{ type: "text", text: unboundReplyText(request.id) }],
        metadata: {
          idempotencyKey: `principal-unbound:${event.adapterId}:${openIdHash}:${utcDayStamp(now)}`,
        },
      },
      source: "ai-run",
    })
    return
  }

  await deps.audit({
    adapterId: event.adapterId,
    kind: "principal.rejected",
    at: now,
    conversationKey: event.conversationKey,
    reason: resolution.status,
    fields: {
      openIdHash,
      ...(resolution.status === "cross_account"
        ? { declaredAccountId: resolution.declaredAccountId }
        : {}),
    },
  })
}
