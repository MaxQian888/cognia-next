import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { getDb } from "@/lib/db/schema"
import {
  ensureConnectorInboundJob,
  markConnectorInboundJobHistoryOnly,
} from "@/lib/db/connector-inbound-jobs"
import { findSessionByConversationKey, insertInboundMessage } from "./runtime"
import { appendAudit } from "./audit"
import { parseControlCommand } from "./commands/parse"

export const DEFAULT_HISTORY_CATCHUP_MS = 24 * 60 * 60 * 1_000
export const DEFAULT_HISTORY_EXECUTION_LIMIT = 100
const MAX_HISTORY_PAGES = 20

export interface HistoryRecoveryBus {
  listAdapters(): PlatformAdapter[]
  dispatchBackfilledInbound(event: NormalizedInboundEvent): Promise<void>
}

async function persistHistoryOnly(event: NormalizedInboundEvent, reason: string): Promise<void> {
  const ensured = await ensureConnectorInboundJob(event, "queue", { historyOnly: true })
  if (!ensured.inserted && ensured.job.status !== "history_only") return
  await markConnectorInboundJobHistoryOnly(ensured.job.id, reason)
  const session = await findSessionByConversationKey(event.conversationKey)
  if (!session) return
  const duplicate = await getDb()
    .messages.where("sessionId")
    .equals(session.id)
    .filter((message) => message.platformMessageId === event.messageId)
    .first()
  if (!duplicate) await insertInboundMessage(event, session.id, event.timestamp)
}

/** Backfill every active persisted scope after adapters reconnect. */
export async function recoverActiveConversationHistory(
  bus: HistoryRecoveryBus,
  options: { now?: number; catchupMs?: number; executionLimit?: number } = {}
): Promise<{ conversations: number; executed: number; historyOnly: number }> {
  const now = options.now ?? Date.now()
  const cutoff = now - (options.catchupMs ?? DEFAULT_HISTORY_CATCHUP_MS)
  const executionLimit = options.executionLimit ?? DEFAULT_HISTORY_EXECUTION_LIMIT
  const adapters = new Map(bus.listAdapters().map((adapter) => [adapter.id, adapter]))
  const states = await getDb()
    .connectorConversationStates.where("activationStatus")
    .equals("active")
    .toArray()
  let conversations = 0
  let executed = 0
  let historyOnly = 0

  for (const state of states) {
    if (state.expiresAt !== undefined && state.expiresAt <= now) continue
    const adapter = adapters.get(state.adapterId)
    if (!adapter?.fetchHistoryPage) continue
    conversations++
    const initialAfter = state.historyCursor?.afterTimestamp ?? cutoff
    const cursor = {
      kind: "timestamp" as const,
      afterTimestamp: initialAfter,
      ...(state.historyCursor?.pageToken ? { pageToken: state.historyCursor.pageToken } : {}),
    }
    let nextCursor: typeof cursor | undefined = cursor
    const events: NormalizedInboundEvent[] = []

    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES && nextCursor; pageIndex++) {
      const page = await adapter.fetchHistoryPage(state.deliveryTarget, nextCursor, { max: 50 })
      events.push(...page.events.filter((event) => event.conversationKey === state.conversationKey))
      nextCursor =
        page.nextCursor?.kind === "timestamp"
          ? {
              kind: "timestamp",
              afterTimestamp: page.nextCursor.afterTimestamp ?? initialAfter,
              ...(page.nextCursor.pageToken ? { pageToken: page.nextCursor.pageToken } : {}),
            }
          : undefined
    }

    const ordered = events.sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.messageId.localeCompare(right.messageId)
    )
    let executedForConversation = 0
    for (const event of ordered) {
      const isHumanCreate =
        (!event.kind || event.kind === "create") &&
        event.sender.remoteUserId !== event.selfId &&
        parseControlCommand(event.plainText).kind === "not-a-command"
      if (isHumanCreate && event.timestamp >= cutoff && executedForConversation < executionLimit) {
        await bus.dispatchBackfilledInbound(event)
        executedForConversation++
        executed++
      } else {
        await persistHistoryOnly(
          event,
          event.timestamp < cutoff ? "history_catchup_too_old" : "history_catchup_execution_limit"
        )
        historyOnly++
      }
    }

    const maxTimestamp = ordered.reduce(
      (highest, event) => Math.max(highest, event.timestamp),
      initialAfter
    )
    await getDb().connectorConversationStates.update(state.conversationKey, {
      historyCursor: nextCursor?.pageToken
        ? { afterTimestamp: initialAfter, pageToken: nextCursor.pageToken }
        : { afterTimestamp: maxTimestamp },
      updatedAt: now,
    })
    await appendAudit({
      adapterId: state.adapterId,
      kind: "inbound.history_recovered",
      at: now,
      conversationKey: state.conversationKey,
      fields: { fetched: ordered.length, executed: executedForConversation },
    }).catch(() => undefined)
  }

  return { conversations, executed, historyOnly }
}
