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
import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { projectInboundToA2UI } from "@/lib/connectors/adapters/_shared/inbound-a2ui-dispatch"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { SendContent, StoredMessage, AppSettings } from "@/lib/claude/types"
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
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { appendAudit } from "./audit"
import { getBus } from "./bus"
import { createPlatformSession, findActiveSessionForConversation } from "./session-bindings"
import { startTeamRunFromIM } from "./team-dispatch"
import { makeImPermissionResponder } from "./hitl/tool-approval"

/**
 * Turn-capture timeout for connector AI-run turns. Raised above the 5-min chat
 * default so an in-flight tool-permission approval (registry TTL 10 min)
 * resolves before the turn times out, while still bounding a stuck sidecar.
 */
const CONNECTOR_TURN_TIMEOUT_MS = 15 * 60 * 1000

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
  options?: import("@/lib/claude/types").SendOptions,
  /**
   * Optional capture controls. The runtime passes `onPartial` here when the
   * target adapter implements `streamReply`, so the assistant's incremental
   * output can drive platform-side streaming (WeCom 智能机器人 stream frames)
   * while the authoritative final message still flows through the durable
   * outbound queue. Production wires this to `runAndCaptureAssistantReply`,
   * whose 4th `RunAndCaptureOptions` arg is a structural superset.
   */
  cap?: import("@/lib/claude/run-and-capture").RunAndCaptureOptions
) => Promise<{
  text: string
  messageId: string
  /**
   * A2UI surfaces emitted during this turn via the `builtin:a2ui-bridge`
   * MCP tools. Empty for plain-text turns. The runtime projects them into
   * `MessageSegment.a2ui` segments via
   * `lib/connectors/a2ui-bridge/a2ui-to-segments.ts`.
   *
   * Optional in the type so older capture wrappers (and the mock used by
   * test stubs that don't care about A2UI) keep compiling — the runtime
   * defaults to an empty record when missing.
   */
  a2uiSurfaces?: Record<string, A2UISegmentContent>
  /**
   * Surface ids in emission order. Optional for the same back-compat
   * reasons as `a2uiSurfaces`.
   */
  a2uiSurfaceOrder?: string[]
}>

export interface RuntimeOptions {
  /**
   * Inject the chat-send entry point. Production wires it to
   * `(sessionId, content, options) => runAndCaptureAssistantReply(...)`
   * from `@/lib/claude/run-and-capture`. Tests pass a mock that resolves
   * to a deterministic `{ text, messageId }`.
   */
  runAndCapture: RunAndCaptureFn
}

// Session ↔ conversation binding lookups live in `session-bindings.ts` so the
// command dispatcher can reuse them without importing this heavy install path.
// Re-exported here so existing importers (`scheduled-outbound.ts`,
// `use-history-hydration.ts`) keep their `from "./runtime"` import unchanged.
export { findSessionByConversationKey, createPlatformSession } from "./session-bindings"

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
      // ADR-0024 — when the inbound OCR step extracted text, hand it to the
      // model as a text block too (alongside the image, so vision-capable
      // models still see the picture). Lets non-vision models read the words.
      if (typeof seg.ocrText === "string" && seg.ocrText.length > 0) {
        blocks.push({ type: "text", text: seg.ocrText })
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
export async function insertInboundMessage(
  event: NormalizedInboundEvent,
  sessionId: string,
  overrideTimestamp?: number
): Promise<StoredMessage> {
  const now = overrideTimestamp ?? Date.now()
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

  // Reverse-project the platform-native rich content (Block Kit, Lark
  // card, Discord embeds, Telegram inline keyboard, OneBot CQ segments)
  // into an InboundA2UIBlock so the Inbox renderer can show native UI
  // structure rather than the plaintext fallback. Best-effort — the
  // mapper returns null when the payload has nothing structured.
  const inboundA2UI = projectInboundToA2UI(event.platform, event.raw)

  const row: StoredMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    parts: finalParts,
    // Denormalized copy of platformMessage.messageId so the v49 messages
    // index resolves edit/delete events in O(log n). Kept in sync with the
    // metadata blob below.
    platformMessageId: event.messageId,
    metadata: {
      platformMessage: {
        messageId: event.messageId,
        platform: event.platform,
        sender: event.sender,
      },
      ...(inboundA2UI ? { inboundA2UI } : {}),
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

    // ── Step 1: resolve the active ChatSession (honoring `/switch` / `/new`) ──
    // Consult `override.activeSessionId` first so an AI turn targets the
    // session the user switched to; fall back to the most-recently-updated
    // bound session, then create one. The override read is best-effort — a
    // failure degrades to "most-recent / create", today's behaviour.
    const step1Override = await readForResolution(event.conversationKey).catch(() => undefined)
    let session = await findActiveSessionForConversation(event.conversationKey, step1Override)
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
        // ── Team dispatch (control-plane multi-agent) ──
        // When the conversation is bound to an Agent Team, route the turn to
        // the team runtime instead of the single-character `runAndCapture`
        // path. The team's progress + final result fan back to this
        // conversation via the workflow-progress-runner (triggeredFrom). Skip
        // the rest of the ai-run branch on success.
        if (overrideRow?.teamId) {
          const res = await startTeamRunFromIM({
            teamId: overrideRow.teamId,
            goal: event.plainText,
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
            sessionId: session.id,
          })
          await appendAudit({
            adapterId: event.adapterId,
            kind: res.started ? "team.dispatched" : "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            ...(res.started ? {} : { reason: res.reason ?? "team_dispatch_failed" }),
            fields: { teamId: overrideRow.teamId, sourceMessageId: storedMsg.id },
          })
          break
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

        // Twin runtime injection (parity with the in-app chat path in
        // use-claude-chat): when the conversation's character is twin-bound,
        // hand resolveSendOptions the RAG deps so the inbound message is
        // grounded in the twin's knowledge. Best-effort — tryBuildTwinDeps
        // returns undefined when the twin runtime is disabled/unconfigured,
        // and a twinId-less character skips the lookup entirely.
        const twinHandshake =
          character?.twinId && event.plainText.trim() ? await tryBuildTwinDeps() : undefined

        const sendOptions = await resolveSendOptions({
          session,
          character,
          appSettings,
          conversationKey: event.conversationKey,
          platformBinding: session.platformBinding,
          inboxPolicy,
          twinDeps: twinHandshake,
          twinUserMessage: twinHandshake ? event.plainText : undefined,
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
        // Always wire `onPermissionRequest` so an ask-tier tool fired mid-turn
        // projects an A2UI Allow/Deny card to the conversation and the turn
        // suspends until the user taps (control-plane HITL). Without this the
        // sidecar's permission_request went unanswered and the turn hung until
        // the 5-min timeout — a latent IM auto-mode bug this also fixes.
        // `onPartial` is additionally wired when the target adapter supports
        // incremental replies (WeCom 智能机器人) so the assistant's growing text
        // drives platform-side stream frames; the authoritative final message
        // still flows through `enqueueOutbound` below. Both are best-effort.
        //
        // The turn timeout is raised to {@link CONNECTOR_TURN_TIMEOUT_MS} so a
        // legitimate human approval (registry TTL 10 min) resolves before the
        // turn times out, while a genuinely stuck sidecar is still bounded.
        const targetAdapter = bus.getAdapter(event.adapterId)
        const cap: import("@/lib/claude/run-and-capture").RunAndCaptureOptions = {
          timeoutMs: CONNECTOR_TURN_TIMEOUT_MS,
          onPermissionRequest: makeImPermissionResponder({
            sessionId: session.id,
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
            conversationRef: event.conversationRef,
            approvalMode: overrideRow?.approvalMode,
          }),
          ...(typeof targetAdapter?.streamReply === "function"
            ? {
                onPartial: (text: string) => {
                  void targetAdapter.streamReply!({
                    conversationRef: event.conversationRef,
                    text,
                  }).catch(() => undefined)
                },
              }
            : {}),
        }

        const prompt = inboundEventToSendContent(event)
        let captured: Awaited<ReturnType<RunAndCaptureFn>>
        try {
          captured = await opts.runAndCapture(session.id, prompt, sendOptions, cap)
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
          // Proactively surface the failure (control-plane notifications): the
          // user otherwise gets silence on a sidecar error. Lands in the
          // Notification Center always, and pushes to IM when the conversation
          // opted in. Dynamic import keeps the notifications runtime out of the
          // connector bundle; best-effort so it never masks the original error.
          void import("@/lib/notifications/conversation-notify")
            .then(({ notifyConversationOverIM }) =>
              notifyConversationOverIM({
                conversationKey: event.conversationKey,
                level: "error",
                title: "回复失败 / Reply failed",
                body: "助手处理这条消息时出错。/ The assistant hit an error processing this message.",
                dedupeKey: `airun-error:${event.conversationKey}`,
              })
            )
            .catch(() => undefined)
          break
        }

        // ── Project text + A2UI surfaces into MessageSegment[] ──
        // The captured reply may include any combination of plain text
        // and A2UI surfaces (created via the builtin:a2ui-bridge MCP
        // tools). `assistantReplyToSegments` projects each surface into
        // a {type:"a2ui", surfaceId, content, plainTextMirror} segment
        // and appends the trailing markdown text — adapter serialisers
        // then route a2ui segments through `_shared/a2ui-mapper.ts` per
        // platform (Slack Block Kit / Lark Interactive Card / Telegram
        // InlineKeyboardMarkup / Discord Embed+Components / OneBot
        // basic segments + plainTextMirror).
        const outboundSegments: MessageSegment[] = assistantReplyToSegments({
          text: captured.text,
          a2uiSurfaces: captured.a2uiSurfaces,
          a2uiSurfaceOrder: captured.a2uiSurfaceOrder,
        })
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
          source: "ai-run",
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
