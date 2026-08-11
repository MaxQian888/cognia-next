import { registerNodeExecutor } from "../registry"
import { guardWorkflowEgress, WorkflowPiiBlockedError } from "@/lib/workflow/runtime/egress-guard"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import { nonRetryable } from "../shared/executor-support"

// ── action.connector.send ─────────────────────────────────────────────────
// Enqueue an outbound message via the existing `outboundQueue`. The queue
// runner (lib/connectors/outbound-runner.ts) picks rows up FIFO per
// conversation lane and handles retries / circuit breakers / rate limits.
registerNodeExecutor({
  kind: "action.connector.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      adapterId?: string
      conversationKey?: string
      content?: string
      cardJson?: string
      idempotencyKey?: string
      replyToMessageId?: string
      threadId?: string
      editTargetMessageId?: string
      waitForDelivery?: boolean
      waitTimeoutMs?: number
      piiGate?: "block" | "redact"
    }
    const adapterId = params.adapterId?.trim()
    const rawConversationKey = params.conversationKey?.trim()
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: "connector",
      requestedMode: params.piiGate,
      value: { content: params.content ?? "", cardJson: params.cardJson },
    })
    const content = guarded.value.content
    if (!adapterId) throw nonRetryable("action.connector.send requires 'adapterId'")
    if (!rawConversationKey) throw nonRetryable("action.connector.send requires 'conversationKey'")
    if (!content) throw nonRetryable("action.connector.send requires non-empty 'content'")
    const idempotencyKey = params.idempotencyKey?.trim() || `${ctx.runId}:${ctx.stepId}`
    // Derive a real conversation ref from the composite key so adapters
    // (which read `channelId` / `threadTs` off the ref, not the key) can
    // resolve the platform recipient. An explicit `threadId` param targets
    // a thread inside the conversation and extends the FIFO lane key.
    const { parseConversationKey, buildConversationKey } = await import("@/types/connectors/event")
    let parsedKey: ReturnType<typeof parseConversationKey>
    try {
      parsedKey = parseConversationKey(rawConversationKey)
    } catch (err) {
      throw nonRetryable(
        `action.connector.send: malformed conversationKey '${rawConversationKey}' — ` +
          (err instanceof Error ? err.message : String(err))
      )
    }
    const threadId = params.threadId?.trim() || parsedKey.threadId
    const conversationKey = threadId
      ? buildConversationKey(
          parsedKey.platform,
          parsedKey.adapterId,
          parsedKey.remoteChatId,
          threadId
        )
      : rawConversationKey
    const editTargetMessageId = params.editTargetMessageId?.trim()
    // Optional A2UI interactive card: `cardJson` carries the surface
    // (`{components, dataModel, rootId, …}`); `content` doubles as the
    // plain-text mirror so capability-fallback platforms still get text.
    type Segments = Parameters<typeof enqueueOutbound>[0]["request"]["segments"]
    let segments: Segments = [{ type: "text", text: content }]
    const rawCardJson = guarded.value.cardJson?.trim()
    if (rawCardJson) {
      let surface: { components?: unknown; rootId?: unknown }
      try {
        surface = JSON.parse(rawCardJson) as { components?: unknown; rootId?: unknown }
      } catch (err) {
        throw nonRetryable(
          `action.connector.send: cardJson is not valid JSON — ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (
        typeof surface !== "object" ||
        surface === null ||
        typeof surface.components !== "object" ||
        surface.components === null ||
        typeof surface.rootId !== "string"
      ) {
        throw nonRetryable(
          "action.connector.send: cardJson must be an A2UI surface object with 'components' and 'rootId'"
        )
      }
      segments = [
        {
          type: "a2ui",
          surfaceId: `wf:${ctx.runId}:${ctx.stepId}`,
          content: surface,
          plainTextMirror: content,
        },
      ] as unknown as Segments
    }
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: {
          platform: parsedKey.platform,
          adapterId,
          channelId: parsedKey.remoteChatId,
          ...(threadId ? { threadTs: threadId } : {}),
        } as Parameters<typeof enqueueOutbound>[0]["request"]["conversationRef"],
        segments,
        replyTo: params.replyToMessageId ? { messageId: params.replyToMessageId } : undefined,
        // Edit-in-place: the outbound runner routes jobs carrying an
        // editTargetMessageId to `adapter.edit()` (falling back to send()
        // with an `edit_unsupported` audit on platforms without edit).
        ...(editTargetMessageId ? { editTargetMessageId } : {}),
        metadata: { idempotencyKey },
      },
      // Provenance per ADR-0009 v41 — the inbox UI uses this to render a
      // "from workflow" badge with click-to-jump on the conversation
      // timeline. `ctx.workflowId` carries the user-authored workflow id
      // (distinct from `ctx.runId` which is the per-execution token).
      source: "workflow",
      sourceWorkflow: {
        workflowId: ctx.workflowId,
        runId: ctx.runId,
        nodeId: ctx.stepId,
      },
    })
    const baseOutput = {
      jobId: job.id,
      adapterId,
      conversationKey,
      idempotencyKey,
      ...(guarded.redacted ? { piiRedacted: true } : {}),
    }
    // Delivery feedback: optionally block until the job settles (or the
    // wait budget elapses) so downstream nodes can branch on the outcome.
    // `delivered` is the crisp boolean; `status` carries the raw job state
    // ("pending"/"sending"/"failed" when the budget ran out first).
    if (params.waitForDelivery === true) {
      const timeoutMs = Math.min(Math.max(params.waitTimeoutMs ?? 30_000, 100), 300_000)
      const { waitForOutboundTerminal } = await import("@/lib/db/outbound-jobs")
      const settled = (await waitForOutboundTerminal(job.id, timeoutMs)) ?? job
      return {
        output: {
          ...baseOutput,
          delivered: settled.status === "sent",
          status: settled.status,
          ...(settled.platformMessageId ? { platformMessageId: settled.platformMessageId } : {}),
          ...(settled.lastErrorCode ? { errorCode: settled.lastErrorCode } : {}),
          ...(settled.lastError ? { errorMessage: settled.lastError } : {}),
        },
      }
    }
    return { output: baseOutput }
  },
})

// ── action.connector.draft ────────────────────────────────────────────────
// Stash the proposed reply in `connectorDrafts` for human approval in the
// Inbox UI. Distinct from connector.send — drafts never auto-send.
registerNodeExecutor({
  kind: "action.connector.draft",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      conversationKey?: string
      sessionId?: string
      content?: string
      sourceMessageId?: string
      ttlMs?: number
    }
    const conversationKey = params.conversationKey?.trim()
    const sessionId = params.sessionId?.trim()
    const content = params.content ?? ""
    if (!conversationKey) throw nonRetryable("action.connector.draft requires 'conversationKey'")
    if (!sessionId) throw nonRetryable("action.connector.draft requires 'sessionId'")
    if (!content) throw nonRetryable("action.connector.draft requires non-empty 'content'")
    const expiresAt =
      typeof params.ttlMs === "number" && params.ttlMs > 0 ? Date.now() + params.ttlMs : undefined
    const draft = await createDraft({
      conversationKey,
      sessionId,
      segments: [{ type: "text", text: content }],
      sourceMessageId: params.sourceMessageId,
      expiresAt,
    })
    return { output: { draftId: draft.id, conversationKey, sessionId } }
  },
})

// ── action.connector.reaction ─────────────────────────────────────────────
// Add OR remove an emoji reaction on an existing platform message via the
// live adapter (bus.addReactionOutbound / removeReactionOutbound). Immediate
// op — no outbound queue. The add path surfaces the platform `reactionId` on
// the output so a later remove node can target exactly this reaction.
registerNodeExecutor({
  kind: "action.connector.reaction",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      adapterId?: string
      messageId?: string
      emoji?: string
      op?: "add" | "remove"
      reactionId?: string
    }
    const adapterId = params.adapterId?.trim()
    const messageId = params.messageId?.trim()
    const op = params.op ?? "add"
    if (!adapterId) throw nonRetryable("action.connector.reaction requires 'adapterId'")
    if (!messageId) throw nonRetryable("action.connector.reaction requires 'messageId'")
    const { getBus } = await import("@/lib/connectors/bus")
    if (op === "remove") {
      const reactionId = params.reactionId?.trim()
      if (!reactionId)
        throw nonRetryable("action.connector.reaction op='remove' requires 'reactionId'")
      const result = await getBus().removeReactionOutbound(adapterId, messageId, reactionId)
      if (!result.ok) {
        const err = result.error
        if (err && (err.code === "adapter_not_found" || err.code === "unsupported")) {
          throw nonRetryable(`action.connector.reaction: ${err.code} — ${err.message}`)
        }
        throw new Error(err?.message ?? "reaction removal failed")
      }
      return { output: { adapterId, messageId, op, reactionId, reacted: false } }
    }
    const emoji = params.emoji?.trim()
    if (!emoji) throw nonRetryable("action.connector.reaction requires 'emoji'")
    const result = await getBus().addReactionOutbound(adapterId, messageId, emoji)
    if (!result.ok) {
      const err = result.error
      // Unsupported platform / unknown adapter are configuration errors —
      // retrying can't fix them. Transient platform errors stay retryable.
      if (err && (err.code === "adapter_not_found" || err.code === "unsupported")) {
        throw nonRetryable(`action.connector.reaction: ${err.code} — ${err.message}`)
      }
      throw new Error(err?.message ?? "reaction failed")
    }
    return {
      output: {
        adapterId,
        messageId,
        op,
        emoji,
        reacted: true,
        ...(result.reactionId ? { reactionId: result.reactionId } : {}),
      },
    }
  },
})

// ── action.connector.delete ───────────────────────────────────────────────
// Recall / delete an already-sent platform message via the live adapter
// (bus.deleteOutbound). Immediate op — no outbound queue.
registerNodeExecutor({
  kind: "action.connector.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { adapterId?: string; messageId?: string }
    const adapterId = params.adapterId?.trim()
    const messageId = params.messageId?.trim()
    if (!adapterId) throw nonRetryable("action.connector.delete requires 'adapterId'")
    if (!messageId) throw nonRetryable("action.connector.delete requires 'messageId'")
    const { getBus } = await import("@/lib/connectors/bus")
    const result = await getBus().deleteOutbound(adapterId, messageId)
    if (!result.ok) {
      const err = result.error
      if (err && (err.code === "adapter_not_found" || err.code === "unsupported")) {
        throw nonRetryable(`action.connector.delete: ${err.code} — ${err.message}`)
      }
      throw new Error(err?.message ?? "delete failed")
    }
    return { output: { adapterId, messageId, deleted: true } }
  },
})

// ── action.connector.forward ──────────────────────────────────────────────
// Forward a single message, or merge-forward several as one combined card,
// to another conversation via the live adapter (bus.forwardOutbound).
// Immediate op — no outbound queue.
registerNodeExecutor({
  kind: "action.connector.forward",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      adapterId?: string
      messageId?: string
      messageIds?: string[]
      targetConversationKey?: string
      piiGate?: "block" | "redact"
    }
    const adapterId = params.adapterId?.trim()
    const target = params.targetConversationKey?.trim()
    const messageId = params.messageId?.trim()
    const messageIds = (params.messageIds ?? []).map((s) => s.trim()).filter(Boolean)
    if (!adapterId) throw nonRetryable("action.connector.forward requires 'adapterId'")
    if (!target) throw nonRetryable("action.connector.forward requires 'targetConversationKey'")
    if (!messageId && messageIds.length === 0) {
      throw nonRetryable("action.connector.forward requires 'messageId' or 'messageIds'")
    }
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: "connector",
      requestedMode: params.piiGate,
      value: {
        trigger: ctx.trigger.payload,
        upstream: ctx.upstream,
        messageId,
        messageIds,
        target,
      },
    })
    // Native forwarding references the original platform message by id. It
    // cannot replace that content with the redacted projection, so fail closed
    // instead of claiming redaction while the adapter sends the original.
    if (guarded.redacted) throw new WorkflowPiiBlockedError("connector")
    const { getBus } = await import("@/lib/connectors/bus")
    const result = await getBus().forwardOutbound(adapterId, {
      ...(messageId ? { messageId } : {}),
      ...(messageIds.length > 0 ? { messageIds } : {}),
      target,
    })
    if (!result.ok) {
      const err = result.error
      if (err && (err.code === "adapter_not_found" || err.code === "unsupported")) {
        throw nonRetryable(`action.connector.forward: ${err.code} — ${err.message}`)
      }
      throw new Error(err?.message ?? "forward failed")
    }
    return {
      output: {
        adapterId,
        target,
        forwarded: true,
        ...(result.platformMessageId ? { platformMessageId: result.platformMessageId } : {}),
      },
    }
  },
})

// ── action.connector.waitReply ────────────────────────────────────────────
// Workflow-side feedback loop: block the run until a matching inbound
// message arrives in the conversation (bus.subscribeInbound), or the wait
// budget elapses. Timeout is NOT an error — the node resolves with
// `replied: false` so downstream branches can route on it. Not retryable:
// a retry would silently double the wait.
registerNodeExecutor({
  kind: "action.connector.waitReply",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => {
    const params = ctx.params as {
      conversationKey?: string
      senderIds?: string[]
      keywords?: string[]
      requireMention?: boolean
      timeoutMs?: number
    }
    const conversationKey = params.conversationKey?.trim()
    if (!conversationKey)
      throw nonRetryable("action.connector.waitReply requires 'conversationKey'")
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 3_600_000)
    const senderIds = (params.senderIds ?? []).map((s) => s.trim()).filter(Boolean)
    const keywords = (params.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean)
    const { getBus } = await import("@/lib/connectors/bus")

    const reply = await new Promise<
      import("@/types/connectors/event").NormalizedInboundEvent | null
    >((resolve) => {
      let settled = false
      const settle = (
        value: import("@/types/connectors/event").NormalizedInboundEvent | null
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        dispose()
        resolve(value)
      }
      const timer = setTimeout(() => settle(null), timeoutMs)
      const dispose = getBus().subscribeInbound((event) => {
        // Fresh messages only — edits/deletes/system events don't count as
        // a reply. `kind` is undefined on plain creates.
        if (event.kind !== undefined && event.kind !== "create") return
        // Match the conversation, tolerating a thread suffix on either side.
        if (
          event.conversationKey !== conversationKey &&
          !event.conversationKey.startsWith(`${conversationKey}:`)
        ) {
          return
        }
        if (
          senderIds.length > 0 &&
          !senderIds.includes(event.sender.remoteUserId) &&
          !senderIds.includes(event.sender.id)
        ) {
          return
        }
        if (params.requireMention === true && event.mentions?.selfMentioned !== true) return
        if (keywords.length > 0) {
          const text = (event.plainText ?? "").toLowerCase()
          if (!keywords.some((k) => text.includes(k))) return
        }
        settle(event)
      })
    })

    if (reply === null) {
      return { output: { replied: false, timedOut: true, conversationKey } }
    }
    return {
      output: {
        replied: true,
        timedOut: false,
        conversationKey: reply.conversationKey,
        messageId: reply.messageId,
        senderId: reply.sender.remoteUserId,
        text: reply.plainText ?? "",
      },
    }
  },
})
