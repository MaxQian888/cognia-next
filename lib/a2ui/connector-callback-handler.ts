/**
 * Production wiring for `ConnectorBus.callbackHandler`.
 *
 * When an IM-side user action arrives (Slack block_actions / Lark
 * interactive card / Telegram callback_query / Discord component), the
 * bus calls this handler. We:
 *
 *   1. Append the action to `a2uiEventHistory` so the surface debugger
 *      and any in-app surface listeners observe it identically to
 *      in-renderer clicks.
 *   2. Drive one AI-loop turn via `runConnectorDigestTurn` with a
 *      synthetic prompt describing the action. That runner already
 *      handles resolveSendOptions → safeSendPrompt → assistantReply
 *      ToSegments → enqueueOutbound, so the assistant's response reaches
 *      the same IM channel through the connector outbound queue. Single
 *      code path for browser-side and IM-side users.
 *
 * The handler is registered by `ConnectorBusProvider` at app startup —
 * test code skips the registration and the bus's callbackHandler stays
 * null (the dispatcher tolerates that and just writes the audit row).
 */

import type { ConnectorCallbackEvent } from "@/types/connectors"
import { getDb } from "@/lib/db/schema"
import { runConnectorDigestTurn } from "@/lib/connectors/scheduled-outbound"
import type { A2UIEventHistoryRow } from "@/lib/db/a2ui-types"

const EVENT_HISTORY_CAP = 1000

/**
 * Default `CallbackHandler` implementation. Side-effects:
 *   - inserts an `a2uiEventHistory` row capped at 1k entries
 *   - drives `runConnectorDigestTurn` with the synthesized prompt
 */
export async function defaultConnectorCallbackHandler(
  event: ConnectorCallbackEvent,
  boundConversationKey: string | null
): Promise<void> {
  // ── Step 1: append to event history ───────────────────────────────
  await appendA2UIEventHistory(event)

  // ── Step 2: drive the AI loop ─────────────────────────────────────
  const conversationKey = boundConversationKey ?? event.conversationKey ?? null
  if (!conversationKey) return
  const prompt = synthesizeCallbackPrompt(event)
  await runConnectorDigestTurn({
    adapterId: event.adapterId,
    conversationKey,
    // Character isn't known to the callback — let the runner fall back
    // to the session's stored characterId. Passing undefined skips the
    // optional getCharacter lookup.
    characterId: undefined,
    prompt,
    sourceTaskId: `cb:${event.triggerId}`,
  })
}

/**
 * Append an A2UI userAction event row so listeners (Settings → A2UI →
 * Debugger, plus any in-app surface subscribers) see the callback.
 * Capped at 1k rows newest-first.
 */
export async function appendA2UIEventHistory(event: ConnectorCallbackEvent): Promise<void> {
  const db = getDb()
  const row: A2UIEventHistoryRow = {
    id: `cb:${event.triggerId}`,
    surfaceId: event.surfaceId,
    type: "userAction",
    payload: {
      source: "connector",
      platform: event.platform,
      adapterId: event.adapterId,
      componentId: event.componentId,
      actionType: event.actionType,
      value: event.value,
      formPayload: event.payload,
      conversationKey: event.conversationKey,
    },
    timestamp: event.timestamp,
  }
  await db.a2uiEventHistory.put(row)

  const total = await db.a2uiEventHistory.count()
  if (total > EVENT_HISTORY_CAP) {
    const overflow = total - EVENT_HISTORY_CAP
    const oldestIds = await db.a2uiEventHistory.orderBy("timestamp").limit(overflow).primaryKeys()
    if (oldestIds.length > 0) {
      await db.a2uiEventHistory.bulkDelete(oldestIds as string[])
    }
  }
}

/**
 * Build a deterministic prompt describing the callback so the assistant
 * can respond meaningfully. Includes the platform, action type, the
 * component id and value, plus form payload when present.
 */
export function synthesizeCallbackPrompt(event: ConnectorCallbackEvent): string {
  const parts: string[] = []
  parts.push(`[A2UI ${event.platform} callback]`)
  parts.push(`surface=${event.surfaceId}`)
  if (event.componentId) parts.push(`component=${event.componentId}`)
  parts.push(`action=${event.actionType}`)
  if (event.value) parts.push(`value=${event.value}`)
  if (event.payload && Object.keys(event.payload).length > 0) {
    parts.push(`payload=${JSON.stringify(event.payload)}`)
  }
  return parts.join(" ")
}
