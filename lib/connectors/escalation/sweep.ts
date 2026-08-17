/**
 * SLA escalation sweep (IM delegation slice 1B).
 *
 * Every tick: select conversations whose `nextResponseDueAt` has passed
 * (indexed — `conversationOverrides.nextResponseDueAt`), skip resolved /
 * snoozed ones, resolve the policy (`row.escalation ?? adapter
 * .defaultEscalation`), and fire every step that is due and has not fired
 * yet (`escalatedStep`). Each fired step is persisted (`escalatedStep` /
 * `escalatedAt`) and audited as `sla.escalated`; each action that could not
 * run is audited as `sla.escalation_action_failed` and the chain continues.
 * Per-row try/catch so one poisoned row cannot stall the others.
 *
 * `markResponded` / `setStatus("resolved")` clear the chain so the next
 * breach restarts at step 0.
 */

import { getDb } from "@/lib/db/schema"
import { getAdapterInstance as getAdapterInstanceDb } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { appendAudit as appendAuditDefault } from "@/lib/connectors/audit"
import { parseConversationKey } from "@/types/connectors/event"
import type { EscalationPolicy } from "@/types/connectors/escalation"
import { loggers } from "@cognia/logging"
import { dueSteps, overdueMinutesAt } from "./policy"
import { runEscalationAction as runEscalationActionDefault } from "./actions"

export interface SweepSlaEscalationsDeps {
  now?: () => number
  getAdapterInstance?: (id: string) => Promise<AdapterInstanceRow | undefined>
  runAction?: typeof runEscalationActionDefault
  appendAudit?: typeof appendAuditDefault
}

export interface SweepSlaEscalationsResult {
  /** Overdue rows examined (after the resolved / snoozed filter). */
  scanned: number
  /** Steps fired across all rows. */
  escalated: number
  /** Actions attempted. */
  actions: number
  /** Actions that reported a failure outcome. */
  failures: number
  /** Rows whose processing threw (caught, logged, skipped). */
  errors: number
}

/** Resolve the policy for a row + adapter, and where it came from. */
export function resolveEscalationPolicy(
  row: Pick<ConversationOverrideRow, "escalation">,
  adapter: Pick<AdapterInstanceRow, "defaultEscalation"> | undefined
): { policy: EscalationPolicy | undefined; source: "override" | "adapter-default" | "none" } {
  if (row.escalation) return { policy: row.escalation, source: "override" }
  if (adapter?.defaultEscalation)
    return { policy: adapter.defaultEscalation, source: "adapter-default" }
  return { policy: undefined, source: "none" }
}

export async function sweepSlaEscalations(
  deps: SweepSlaEscalationsDeps = {}
): Promise<SweepSlaEscalationsResult> {
  const now = (deps.now ?? Date.now)()
  const getAdapterInstance = deps.getAdapterInstance ?? getAdapterInstanceDb
  const runAction = deps.runAction ?? runEscalationActionDefault
  const appendAudit = deps.appendAudit ?? appendAuditDefault
  const db = getDb()
  const result: SweepSlaEscalationsResult = {
    scanned: 0,
    escalated: 0,
    actions: 0,
    failures: 0,
    errors: 0,
  }

  const overdue = await db.conversationOverrides
    .where("nextResponseDueAt")
    .belowOrEqual(now)
    .toArray()

  for (const initial of overdue) {
    if (initial.status === "resolved" || initial.status === "snoozed") continue
    if (initial.nextResponseDueAt === undefined) continue
    result.scanned++
    try {
      let adapterId: string
      try {
        adapterId = parseConversationKey(initial.conversationKey).adapterId
      } catch {
        continue
      }
      const adapter = await getAdapterInstance(adapterId)
      if (!adapter) continue
      const { policy, source } = resolveEscalationPolicy(initial, adapter)
      if (!policy || policy.steps.length === 0) continue

      const overdueMinutes = Math.floor(overdueMinutesAt(initial.nextResponseDueAt, now))
      const due = dueSteps(policy, overdueMinutes, initial.escalatedStep)
      if (due.length === 0) continue

      let row = initial
      for (const { index, step } of due) {
        const ran: string[] = []
        const failed: Array<{ action: string; reason: string }> = []
        for (const [actionIndex, action] of step.actions.entries()) {
          result.actions++
          const outcome = await runAction(
            {
              adapter,
              row,
              conversationKey: row.conversationKey,
              stepIndex: index,
              overdueMinutes,
              now,
            },
            action
          )
          ran.push(action.type)
          if (!outcome.ok) {
            result.failures++
            failed.push({ action: action.type, reason: outcome.reason })
            await appendAudit({
              adapterId: adapter.id,
              projectId: row.projectId,
              kind: "sla.escalation_action_failed",
              at: now,
              conversationKey: row.conversationKey,
              reason: outcome.reason,
              message: outcome.message,
              fields: {
                step: index,
                actionIndex,
                action: action.type,
                overdueMinutes,
                policySource: source,
              },
            }).catch(() => undefined)
          }
          // Actions mutate the row (reassign / switchMode) — refresh so the
          // next action / step sees the current assignee and mode.
          row = (await readForResolution(row.conversationKey)) ?? row
        }
        await db.conversationOverrides.update(row.id, {
          escalatedStep: index,
          escalatedAt: now,
          updatedAt: now,
        })
        result.escalated++
        await appendAudit({
          adapterId: adapter.id,
          projectId: row.projectId,
          kind: "sla.escalated",
          at: now,
          conversationKey: row.conversationKey,
          fields: {
            step: index,
            afterOverdueMinutes: step.afterOverdueMinutes,
            overdueMinutes,
            actions: ran,
            failed,
            policySource: source,
          },
        }).catch(() => undefined)
      }
    } catch (err) {
      result.errors++
      loggers.network.warn("[sla-escalation] row sweep failed", {
        conversationKey: initial.conversationKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
