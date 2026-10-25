"use client"

/**
 * The shadow report, live (ADR-0239): the receipts enforcement would change,
 * folded by `buildShadowReport`, with the names this device can put on them.
 *
 * Recipients are named from what the device already holds: every conversation
 * a connector has a delivery target for, every bound session, and every entry
 * on a list a person wrote. Nothing is fetched from a platform.
 */

import { useLiveQuery } from "dexie-react-hooks"

import type {
  ActionReviewReceipt,
  OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"
import { getDb } from "@/lib/db/schema"
import {
  conversationTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"
import { buildShadowReport, type ShadowReport } from "@/lib/policy/action-review/shadow-report"

export interface ShadowReportView {
  report: ShadowReport
  /** Connector instance display names, by adapter id. */
  adapterNames: ReadonlyMap<string, string>
  /** Scheduled task names, by task id. */
  taskNames: ReadonlyMap<string, string>
  /** Session titles of known conversations, by normalized recipient. */
  conversationTitles: ReadonlyMap<string, string>
}

/** Read everything the report needs, once. Exported for its test. */
export async function loadShadowReport(): Promise<ShadowReportView> {
  const db = getDb()
  const [receipts, states, sessions, adapters, bots, tasks] = await Promise.all([
    db.actionReviewReceipts
      .filter((row) => {
        const plan = row.request.plan
        return !!plan && !plan.enforced && plan.outcome !== "allow"
      })
      .toArray(),
    db.connectorConversationStates.toCollection().primaryKeys(),
    db.sessions.filter((session) => session.platformBinding != null).toArray(),
    db.adapterInstances.toArray(),
    db.botInstallations.toArray(),
    loadTaskNames(),
  ])

  const candidates: OutboundTarget[] = []
  const conversationTitles = new Map<string, string>()
  for (const key of states as string[]) {
    const target = conversationTarget(key)
    if (target) candidates.push(target)
  }
  for (const session of sessions) {
    const key = session.platformBinding?.conversationKey
    const target = key ? conversationTarget(key) : undefined
    if (!target) continue
    candidates.push(target)
    const title = session.title?.trim()
    if (title && !conversationTitles.has(target.recipient)) {
      conversationTitles.set(target.recipient, title)
    }
  }

  const botLists = new Map<string, readonly OutboundRecipientGrant[]>()
  for (const bot of bots) {
    botLists.set(bot.id, bot.outboundRecipients ?? [])
    for (const grant of bot.outboundRecipients ?? []) candidates.push(grant.recipient)
  }
  const adapterLists = new Map<string, readonly OutboundRecipientGrant[]>()
  const adapterNames = new Map<string, string>()
  for (const adapter of adapters) {
    adapterLists.set(adapter.id, adapter.outboundRecipients ?? [])
    adapterNames.set(adapter.id, adapter.displayName || adapter.id)
    for (const grant of adapter.outboundRecipients ?? []) candidates.push(grant.recipient)
  }

  return {
    report: buildShadowReport({
      receipts: receipts as ActionReviewReceipt[],
      candidates,
      botLists,
      adapterLists,
    }),
    adapterNames,
    taskNames: tasks,
    conversationTitles,
  }
}

async function loadTaskNames(): Promise<Map<string, string>> {
  try {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    const tasks = await schedulerDb.getAllTasks()
    return new Map(tasks.map((task) => [task.id, task.name]))
  } catch {
    // Names are decoration; a report without them still says what it found.
    return new Map()
  }
}

/** `undefined` while the first read is in flight, or when `enabled` is false. */
export function useShadowReport(enabled = true): ShadowReportView | undefined {
  return useLiveQuery(
    async () => (enabled && typeof window !== "undefined" ? loadShadowReport() : undefined),
    [enabled]
  )
}
