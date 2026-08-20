/**
 * SLA escalation actions (IM delegation slice 1B). One function per
 * `EscalationAction` type, dispatched by `runEscalationAction`. Every action
 * returns an outcome instead of throwing so the sweep can audit
 * `sla.escalation_action_failed` and keep walking the chain.
 *
 *   - notify     → Notification Center + toast, dedupe `sla:<key>:<step>`.
 *   - reassign   → `setAssignee(..., { via: "sla-escalation" })` — routing
 *                  follows the assignment (slice 1A) — then the assignment
 *                  notification.
 *   - switchMode → `updateConversationConfigSection({ section: "behavior",
 *                  source: "sla-escalation" })`.
 *   - urgent     → Lark-only (`PlatformAdapter.sendUrgent`): a notice message
 *                  is enqueued through the governed gateway (source "manual",
 *                  PII fail-closed), awaited to a terminal status, then the
 *                  platform message id is escalated via `getBus()
 *                  .sendUrgentOutbound`. Any other platform → outcome
 *                  `unsupported_platform` (INTENTIONALLY INERT — see the type
 *                  doc in `types/connectors/escalation.ts`; the editor renders
 *                  the action disabled and its test pins that).
 *
 * PATTERN NOTE — like `IM_FAILURE_NOTICE`, the canned notice texts are inline
 * bilingual "zh / en" (this runs on the sweep, outside React).
 */

import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { EscalationAction } from "@/types/connectors/escalation"
import { isUrgentCapablePlatform } from "@/types/connectors/escalation"
import type { NotificationInput } from "@/types/notifications"
import { notify as notifyCenter } from "@/lib/notifications/runtime"
import {
  setAssignee as setAssigneeDb,
  updateConversationConfigSection as updateConfigSectionDb,
  type ConversationAssignee,
} from "@/lib/db/conversation-overrides"
import { waitForOutboundTerminal as waitForOutboundTerminalDb } from "@/lib/db/outbound-jobs"
import { enqueueGoverned as enqueueGovernedGateway } from "@/lib/connectors/delivery-gateway"
import { findSessionByConversationKey as findSessionDb } from "@/lib/connectors/session-bindings"
import { getBus as getConnectorBus } from "@/lib/connectors/bus"
import {
  assignmentHref,
  notifyAssignmentChanged as notifyAssignmentChangedDefault,
} from "@/lib/connectors/assignment/notify-assignment"

/** How long the `urgent` action waits for the notice message to reach a terminal outbound status. */
export const URGENT_NOTICE_TIMEOUT_MS = 30_000

export const SLA_ESCALATION_NOTICE = {
  overdue: {
    title: "SLA 已超时 / SLA breached",
    body: (minutes: number, step: number) =>
      `会话已超时 ${minutes} 分钟未回复（升级 L${step + 1}）/ No reply ${minutes} min past the SLA (escalation L${step + 1})`,
  },
  urgent: {
    text: (minutes: number, sourceKey?: string) =>
      `⚠️ SLA 升级 / SLA escalation: 该会话已超时 ${minutes} 分钟未回复，请尽快处理。/ This conversation has been waiting ${minutes} min past its SLA — please pick it up.` +
      (sourceKey ? `\n(${sourceKey})` : ""),
  },
} as const

export interface EscalationActionContext {
  adapter: AdapterInstanceRow
  row: ConversationOverrideRow
  conversationKey: string
  /** 0-based index of the step being executed. */
  stepIndex: number
  /** Whole minutes past the deadline at execution time. */
  overdueMinutes: number
  now: number
}

export type EscalationActionOutcome = { ok: true } | { ok: false; reason: string; message?: string }

export interface EscalationActionDeps {
  notify?: (input: NotificationInput) => Promise<string>
  setAssignee?: typeof setAssigneeDb
  notifyAssignmentChanged?: typeof notifyAssignmentChangedDefault
  updateConversationConfigSection?: typeof updateConfigSectionDb
  enqueueGoverned?: typeof enqueueGovernedGateway
  waitForOutboundTerminal?: typeof waitForOutboundTerminalDb
  findSessionByConversationKey?: typeof findSessionDb
  getBus?: () => Pick<ReturnType<typeof getConnectorBus>, "getAdapter" | "sendUrgentOutbound">
}

function fail(reason: string, err?: unknown): EscalationActionOutcome {
  return {
    ok: false,
    reason,
    ...(err !== undefined ? { message: err instanceof Error ? err.message : String(err) } : {}),
  }
}

async function runNotify(
  ctx: EscalationActionContext,
  deps: EscalationActionDeps
): Promise<EscalationActionOutcome> {
  const notify = deps.notify ?? notifyCenter
  try {
    await notify({
      source: "connector",
      level: "warning",
      title: SLA_ESCALATION_NOTICE.overdue.title,
      body: SLA_ESCALATION_NOTICE.overdue.body(ctx.overdueMinutes, ctx.stepIndex),
      channels: ["center", "toast"],
      href: assignmentHref(ctx.conversationKey),
      groupKey: ctx.conversationKey,
      dedupeKey: `sla:${ctx.conversationKey}:${ctx.stepIndex}`,
      sourceRef: { kind: "conversation", id: ctx.conversationKey },
      directed: true,
      meta: { kind: "sla-escalation", step: ctx.stepIndex, overdueMinutes: ctx.overdueMinutes },
    })
    return { ok: true }
  } catch (err) {
    return fail("notify_failed", err)
  }
}

async function runReassign(
  ctx: EscalationActionContext,
  assignee: ConversationAssignee,
  deps: EscalationActionDeps
): Promise<EscalationActionOutcome> {
  const setAssignee = deps.setAssignee ?? setAssigneeDb
  const notifyAssignmentChanged = deps.notifyAssignmentChanged ?? notifyAssignmentChangedDefault
  try {
    await setAssignee(ctx.conversationKey, assignee, {
      sessionId: ctx.row.sessionId,
      via: "sla-escalation",
      adapterId: ctx.adapter.id,
    })
  } catch (err) {
    return fail("reassign_failed", err)
  }
  await notifyAssignmentChanged({
    conversationKey: ctx.conversationKey,
    from: ctx.row.assignee ?? null,
    to: assignee,
    via: "sla-escalation",
  })
  return { ok: true }
}

async function runSwitchMode(
  ctx: EscalationActionContext,
  mode: "manual" | "draft",
  deps: EscalationActionDeps
): Promise<EscalationActionOutcome> {
  const update = deps.updateConversationConfigSection ?? updateConfigSectionDb
  try {
    await update({
      adapterId: ctx.adapter.id,
      conversationKey: ctx.conversationKey,
      sessionId: ctx.row.sessionId,
      section: "behavior",
      patch: {
        mode,
        // The axis-native counterpart, written alongside its legacy mirror.
        autonomy: mode === "manual" ? "observe" : "suggest",
        // Provenance. Without it the effective-config facade collapses an
        // escalation-driven change to `conversation-override`, so the ladder
        // rewriting a conversation's mode was invisible in every UI — the same
        // defect `routingSource: "assignment"` was added to fix.
        modeForcedBy: "escalation",
        // Snapshot ONCE so a later unassign can undo an escalation-forced mode
        // while an assignment is in force. Without this `restoreMode` had
        // nothing to restore and the escalation's choice outlived the
        // assignment that framed it.
        ...(ctx.row.routingSource === "assignment" && ctx.row.assignmentPreviousMode === undefined
          ? {
              assignmentPreviousMode: ctx.row.mode ?? null,
              assignmentPreviousAutonomy: ctx.row.autonomy ?? null,
              assignmentPreviousEngagement: ctx.row.engagement ?? null,
            }
          : {}),
      },
      source: "sla-escalation",
    })
    return { ok: true }
  } catch (err) {
    return fail("switch_mode_failed", err)
  }
}

async function runUrgent(
  ctx: EscalationActionContext,
  action: Extract<EscalationAction, { type: "urgent" }>,
  deps: EscalationActionDeps
): Promise<EscalationActionOutcome> {
  // Dormancy pin: only Lark implements `sendUrgent`. Recorded, not thrown.
  if (!isUrgentCapablePlatform(ctx.adapter.type)) return fail("unsupported_platform")
  const userIds = (action.userIds ?? []).map((u) => u.trim()).filter(Boolean)
  if (userIds.length === 0) return fail("urgent_users_missing")
  const bus = (deps.getBus ?? getConnectorBus)()
  const live = bus.getAdapter(ctx.adapter.id)
  if (!live) return fail("adapter_offline")
  if (typeof live.sendUrgent !== "function") return fail("unsupported_platform")

  const targetKey = action.targetConversationKey?.trim() || ctx.conversationKey
  const findSession = deps.findSessionByConversationKey ?? findSessionDb
  const session = await findSession(targetKey).catch(() => undefined)
  const binding = session?.platformBinding
  if (!binding) return fail("no_bound_session")
  if (binding.adapterId !== ctx.adapter.id) return fail("target_adapter_mismatch")

  const enqueue = deps.enqueueGoverned ?? enqueueGovernedGateway
  const waitTerminal = deps.waitForOutboundTerminal ?? waitForOutboundTerminalDb
  let jobId: string
  try {
    const job = await enqueue({
      adapterId: ctx.adapter.id,
      conversationKey: targetKey,
      request: {
        conversationRef: binding.conversationRef,
        deliveryTarget: binding.deliveryTarget,
        segments: [
          {
            type: "text",
            text: SLA_ESCALATION_NOTICE.urgent.text(
              ctx.overdueMinutes,
              targetKey === ctx.conversationKey ? undefined : ctx.conversationKey
            ),
          },
        ],
        metadata: { idempotencyKey: `sla-urgent:${ctx.conversationKey}:${ctx.stepIndex}` },
      },
      source: "manual",
    })
    jobId = job.id
  } catch (err) {
    return fail("notice_enqueue_failed", err)
  }
  const terminal = await waitTerminal(jobId, URGENT_NOTICE_TIMEOUT_MS)
  if (!terminal || terminal.status !== "sent" || !terminal.platformMessageId) {
    return fail("notice_not_delivered", terminal?.lastError ?? terminal?.status ?? "timeout")
  }
  const result = await bus.sendUrgentOutbound(
    ctx.adapter.id,
    terminal.platformMessageId,
    userIds,
    action.via
  )
  if (!result.ok) return fail(result.error?.code ?? "urgent_failed", result.error?.message)
  return { ok: true }
}

/** Execute one escalation action; never throws. */
export async function runEscalationAction(
  ctx: EscalationActionContext,
  action: EscalationAction,
  deps: EscalationActionDeps = {}
): Promise<EscalationActionOutcome> {
  try {
    switch (action.type) {
      case "notify":
        return await runNotify(ctx, deps)
      case "reassign":
        return await runReassign(ctx, action.assignee, deps)
      case "switchMode":
        return await runSwitchMode(ctx, action.mode, deps)
      case "urgent":
        return await runUrgent(ctx, action, deps)
      default:
        return fail("action_type_unknown", (action as { type?: string }).type)
    }
  } catch (err) {
    return fail("action_threw", err)
  }
}
