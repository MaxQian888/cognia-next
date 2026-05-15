/**
 * Bus runtime — Task 37 + IM-completion §A (real ai-run capture).
 *
 * Wires the ConnectorBus route-handler callback into the chat-send pipeline.
 * Each routed inbound event:
 *   1. Finds or creates the ChatSession for the conversation.
 *   2. Inserts the inbound StoredMessage.
 *   3. Branches on RouteDecision:
 *      - "ai-run"        → resolveSendOptions(inbox context) → suppression
 *                          gate → runAndCapture(...) → enqueueOutbound with
 *                          the captured assistant text.
 *      - "manual-store"  → nothing further (session + message already written).
 *      - "draft-prepare" → create a ConnectorDraft with placeholder segments.
 *      - "store-only"    → nothing further.
 *      - "drop"          → skip StoredMessage insert; audit policy_blocked.
 *
 * NOTE: the bus already writes "inbound.policy_blocked" / "inbound.received"
 * audit entries before calling the routeHandler. The handler adds extra audit
 * entries where a distinct action was taken (ai-run enqueue, draft creation,
 * deferred suppression).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { SendContent, ChatSession, StoredMessage, AppSettings } from "@/lib/claude/types"
import type { AuditKind } from "@/types/connectors/audit"
import type { InboxSendPolicy } from "@/lib/claude/build-options"
import { getDb } from "@/lib/db/schema"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getCharacter } from "@/lib/db/characters"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { appendAudit } from "./audit"
import { getBus } from "./bus"

/**
 * Capture-aware Claude turn driver. Production wires it to
 * `runAndCaptureAssistantReply` from `@/lib/claude/run-and-capture`. Tests
 * pass a mock returning a deterministic `{ text, messageId }`.
 *
 * The capture wrapper is responsible for: subscribing to the sidecar event
 * channel, calling `sendPrompt` under the hood, accumulating the assistant
 * reply, and resolving once the session ends. The runtime treats the
 * resulting text as the body to enqueue for outbound delivery.
 */
export type RunAndCaptureFn = (
  sessionId: string,
  prompt: SendContent,
  options?: import("@/lib/claude/types").SendOptions
) => Promise<{ text: string; messageId: string }>

export interface RuntimeOptions {
  /**
   * Inject the chat-send entry point. Production wires it to
   * `(sessionId, content, options) => runAndCaptureAssistantReply(...)`
   * from `@/lib/claude/run-and-capture`. Tests pass a mock that resolves
   * to a deterministic `{ text, messageId }`.
   */
  runAndCapture: RunAndCaptureFn
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
 * Map a NormalizedInboundEvent's `segments` into the Claude SDK's
 * `SendContent` shape. Text + markdown segments collapse into text blocks;
 * image segments become base64 image blocks when the adapter supplied
 * inline data, otherwise degrade to a `[image: <url>]` text marker so the
 * model still has SOMETHING to react to. Other segment kinds (file, voice,
 * video) degrade to a one-line text marker — Phase 2 attachment caching
 * (ADR 0009) will revisit this once the cache pipeline is wired.
 *
 * Exported so `runtime.test.ts` can exercise the mapping in isolation.
 */
export function inboundEventToSendContent(event: NormalizedInboundEvent): SendContent {
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  > = []

  for (const seg of event.segments) {
    if (seg.type === "text") {
      if (seg.text.length > 0) blocks.push({ type: "text", text: seg.text })
      continue
    }
    if (seg.type === "markdown") {
      if (seg.md.length > 0) blocks.push({ type: "text", text: seg.md })
      continue
    }
    if (seg.type === "image") {
      const inline = (seg as { dataBase64?: string; mimeType?: string }).dataBase64
      const mime = (seg as { mimeType?: string }).mimeType ?? "image/png"
      if (typeof inline === "string" && inline.length > 0) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: inline },
        })
      } else if (typeof seg.url === "string" && seg.url.length > 0) {
        blocks.push({ type: "text", text: `[image: ${seg.url}]` })
      }
      continue
    }
    // file / voice / video / unknown — degrade to a text marker. We use
    // `seg.type` so the model can at least see what kind of attachment
    // arrived, instead of silently swallowing it.
    blocks.push({ type: "text", text: `[${seg.type}]` })
  }

  // Always include `plainText` as a final text block when the segment list
  // produced nothing — guarantees the model never sees an empty user turn.
  if (blocks.length === 0) {
    return event.plainText.length > 0 ? event.plainText : "[empty]"
  }

  // When every block is text, hand back a plain string for the SDK's
  // back-compat code path (fewer surprises in logs).
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => (b as { text: string }).text).join("\n")
  }
  return blocks
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
 * Map a `SendOptions.suppressedReason` to its corresponding deferred audit
 * kind. Centralised so the audit log gives the troubleshooter the strongest
 * single reason without branching at the call site.
 */
function suppressedReasonToAuditKind(
  reason: NonNullable<import("@/lib/claude/types").SendOptions["suppressedReason"]>
): AuditKind {
  switch (reason) {
    case "quiet_hours":
      return "inbound.deferred_quiet_hours"
    case "muted":
      return "inbound.deferred_muted"
    case "manual_mode_override":
      return "inbound.deferred_manual_mode"
  }
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

    // ── Edit / delete events: route to bus's edit/delete handler instead of
    // creating a new StoredMessage. The bus owns the in-place update path
    // because it has the inboundLedger context to resolve `replacesMessageId`
    // back to the original `StoredMessage`. The runtime's job here is only
    // the create / ai-run / draft-prepare / manual-store paths.
    if (event.kind === "edit" || event.kind === "delete" || event.kind === "system") {
      // The bus's dispatchInboundFull short-circuits these before they reach
      // the routeHandler in production, but we leave a defensive return here
      // in case a connector pushes one through a different path.
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
        // Real ai-run path: build the SendOptions with inbox context, check
        // the suppression gate, and either short-circuit (write a deferred
        // audit) or invoke the capture wrapper and enqueue the result.
        //
        // All the lookups are best-effort. A missing adapter row, override,
        // character, or AppSettings should not crash the pipeline — we fall
        // through to a no-policy resolveSendOptions call so the adapter
        // still produces SOMETHING for the user. The capture wrapper itself
        // is wrapped in try/catch so a sidecar failure becomes an
        // "adapter.error" audit row, not an unhandled rejection.
        let adapterRow
        let overrideRow
        let appSettings: AppSettings | undefined
        let character
        try {
          adapterRow = await getAdapterInstance(event.adapterId)
        } catch {
          adapterRow = undefined
        }
        try {
          overrideRow = await readForResolution(event.conversationKey)
        } catch {
          overrideRow = undefined
        }
        try {
          appSettings = await getSettings()
        } catch {
          appSettings = undefined
        }
        if (resolved.characterId) {
          try {
            character = await getCharacter(resolved.characterId)
          } catch {
            character = undefined
          }
        }

        const inboxPolicy: InboxSendPolicy = {
          quietHours: adapterRow?.quietHours,
          muted: adapterRow?.muted,
          forcedMode: overrideRow?.mode,
        }

        const sendOptions = await resolveSendOptions({
          session,
          character,
          appSettings,
          conversationKey: event.conversationKey,
          platformBinding: session.platformBinding,
          inboxPolicy,
        })

        // ── Suppression gate: short-circuit before the sidecar call ──
        if (sendOptions.suppressedReason) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: suppressedReasonToAuditKind(sendOptions.suppressedReason),
            at: now,
            conversationKey: event.conversationKey,
            reason: sendOptions.suppressedReason,
            fields: { sourceMessageId: storedMsg.id },
          })
          break
        }

        // ── Capture the assistant reply via the injected wrapper ──
        const prompt = inboundEventToSendContent(event)
        let captured: { text: string; messageId: string }
        try {
          captured = await opts.runAndCapture(session.id, prompt, sendOptions)
        } catch (err) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            reason: "ai_run_capture_failed",
            message: err instanceof Error ? err.message : String(err),
            fields: { sourceMessageId: storedMsg.id },
          })
          break
        }

        // ── Enqueue the outbound delivery job ──
        const outboundSegments: MessageSegment[] = [{ type: "text", text: captured.text }]
        const idempotencyKey = `airun:${captured.messageId}`
        await enqueueOutbound({
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          request: {
            conversationRef: event.conversationRef,
            segments: outboundSegments,
            metadata: {
              idempotencyKey,
              sourceMessageId: storedMsg.id,
            },
          },
        })

        await appendAudit({
          adapterId: event.adapterId,
          kind: "outbound.ai_run_enqueued",
          at: Date.now(),
          conversationKey: event.conversationKey,
          idempotencyKey,
          message: captured.messageId,
          fields: {
            assistantMessageId: captured.messageId,
            sourceMessageId: storedMsg.id,
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
