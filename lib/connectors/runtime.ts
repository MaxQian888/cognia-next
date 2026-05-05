/**
 * Bus runtime — Task 37.
 *
 * Wires the ConnectorBus route-handler callback into the chat-send pipeline.
 * Each routed inbound event:
 *   1. Finds or creates the ChatSession for the conversation.
 *   2. Inserts the inbound StoredMessage.
 *   3. Branches on RouteDecision:
 *      - "ai-run"        → audit + enqueue placeholder outbound job (Phase 1 stub)
 *      - "manual-store"  → nothing further (session + message already written)
 *      - "draft-prepare" → create a ConnectorDraft with placeholder segments
 *      - "store-only"    → nothing further
 *      - "drop"          → skip StoredMessage insert; audit policy_blocked
 *
 * NOTE: the bus already writes "inbound.policy_blocked" / "inbound.received"
 * audit entries before calling the routeHandler. The handler adds extra audit
 * entries where a distinct action was taken (ai-run enqueue, draft creation).
 *
 * TODO(phase 1+): replace the "ai-run" stub with real sendPrompt result
 * capture once the streaming completion pipeline is wired here. See Task 40+.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { SendOptions } from "@/lib/claude/types"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import { appendAudit } from "./audit"
import { getBus } from "./bus"

export interface RuntimeOptions {
  /**
   * Inject the chat-send entry point. Production wires it to
   * `(sessionId, content, options) => sendPrompt(sessionId, content, options)`
   * from `@/lib/claude/ipc`. Tests pass a mock.
   *
   * TODO(phase 1+): replace stub with real sendPrompt result capture.
   * For Phase 1, installRuntime records "ai-run" via audit and enqueues a
   * placeholder outbound job rather than invoking the full streaming pipeline.
   */
  sendPrompt: (sessionId: string, content: string, options?: SendOptions) => Promise<void>
}

/**
 * Find an existing ChatSession whose `platformBinding.conversationKey`
 * matches the given key, or return undefined if none.
 */
async function findSessionByConversationKey(
  conversationKey: string
): Promise<ChatSession | undefined> {
  const sessions = await getDb().sessions.toArray()
  return sessions.find((s) => s.platformBinding?.conversationKey === conversationKey)
}

/**
 * Create a ChatSession bound to the given platform conversation.
 */
async function createPlatformSession(
  event: NormalizedInboundEvent,
  characterId: string | undefined
): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: event.channel.name ?? event.sender.displayName ?? event.conversationKey,
    kind: "direct",
    characterId,
    platformBinding: {
      platform: event.platform,
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      conversationRef: event.conversationRef,
    },
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.add(session)
  return session
}

/**
 * Build and insert a StoredMessage for the inbound event.
 */
async function insertInboundMessage(
  event: NormalizedInboundEvent,
  sessionId: string
): Promise<StoredMessage> {
  const now = Date.now()
  // Map MessageSegment[] → UIMessage parts (text & image; others as text-fallback)
  const parts: StoredMessage["parts"] = event.segments
    .map((seg) => {
      if (seg.type === "text" || seg.type === "markdown") {
        return {
          type: "text" as const,
          text: seg.type === "text" ? seg.text : seg.md,
        }
      }
      if (seg.type === "image") {
        return { type: "text" as const, text: `[image: ${seg.url}]` }
      }
      // Other segment types degrade to a text placeholder for Phase 1
      return { type: "text" as const, text: event.plainText }
    })
    .filter((_, i, arr) => {
      // De-duplicate fallback entries: only keep one text part when all
      // segments collapsed to the same plainText.
      if (i === 0) return true
      const prev = arr[i - 1]
      const curr = arr[i]
      if (prev.type === "text" && curr.type === "text" && prev.text === curr.text) return false
      return true
    })

  // If the segment list was empty, fall back to plainText
  const finalParts: StoredMessage["parts"] =
    parts.length > 0 ? parts : [{ type: "text", text: event.plainText }]

  const row: StoredMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    parts: finalParts,
    metadata: {
      platformMessage: {
        messageId: event.messageId,
        platform: event.platform,
        sender: event.sender,
      },
    },
    createdAt: now,
  }
  await getDb().messages.add(row)
  return row
}

/**
 * Install the route handler on the bus singleton.
 *
 * Call this once at app startup (e.g. from ConnectorBusProvider).
 */
export function installRuntime(bus: ReturnType<typeof getBus>, opts: RuntimeOptions): void {
  bus.routeHandler = async (
    event: NormalizedInboundEvent,
    decision: RouteDecision,
    resolved: ResolvedBinding
  ): Promise<void> => {
    const now = Date.now()

    // ── "drop" → skip all storage; bus already wrote policy_blocked audit ──
    if (decision === "drop") {
      return
    }

    // ── Step 1: find or create ChatSession ───────────────────────────────────
    let session = await findSessionByConversationKey(event.conversationKey)
    if (!session) {
      session = await createPlatformSession(event, resolved.characterId)
    }

    // ── Step 2: insert inbound StoredMessage ─────────────────────────────────
    const storedMsg = await insertInboundMessage(event, session.id)

    // ── Step 3: branch on decision ───────────────────────────────────────────
    switch (decision) {
      case "ai-run": {
        // TODO(phase 1+): replace stub with real sendPrompt result capture.
        // The full streaming pipeline (opts.sendPrompt → streaming assistant
        // reply → captured final text → enqueueOutbound) is deferred to
        // Task 40+. For Phase 1 we record the intent via audit and enqueue a
        // placeholder job so the outbound-runner can be exercised end-to-end.

        await appendAudit({
          adapterId: event.adapterId,
          kind: "outbound.enqueued",
          at: now,
          conversationKey: event.conversationKey,
          message: "ai-run:stub",
        })

        await enqueueOutbound({
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          request: {
            conversationRef: event.conversationRef,
            segments: [{ type: "text", text: "[AI reply placeholder]" }],
            metadata: {
              idempotencyKey: crypto.randomUUID(),
              sourceMessageId: storedMsg.id,
            },
          },
        })
        break
      }

      case "draft-prepare": {
        // Create a draft with placeholder segments; real AI invocation is later.
        await createDraft({
          conversationKey: event.conversationKey,
          sessionId: session.id,
          segments: [{ type: "text", text: "[Draft placeholder]" }],
          sourceMessageId: storedMsg.id,
        })
        break
      }

      case "manual-store":
      case "store-only":
        // StoredMessage already inserted; nothing more to do.
        break
    }
  }
}
