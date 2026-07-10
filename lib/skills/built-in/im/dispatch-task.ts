/**
 * `im.dispatch_task` — lead-agent task dispatch (W4 任务派发).
 *
 * A lead agent decomposes work and farms a sub-task out to a dedicated
 * conversation: create a NEW group chat (or target an existing conversation),
 * BIND a responder (Agent Team or character) to it via the per-conversation
 * override row, post the task brief as the first message, and — for teams —
 * optionally kick off the team run immediately. Follow-ups then happen in the
 * sub-task's own chat (inbound routes to the bound responder).
 *
 * Superset of `im.create_chat`'s flow; reuses `bootstrapConversation`,
 * `upsertByConversationKey`, the durable outbound queue, and
 * `startTeamRunFromIM` — no new dispatch machinery.
 */

import { z } from "zod"

import type { ConversationReference } from "@/types/connectors/event"
import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { previewText, requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const schema = z
  .object({
    title: z
      .string()
      .min(1)
      .describe("Task headline — becomes the new chat's name and the message headline."),
    brief: z
      .string()
      .min(1)
      .describe("Sub-task description posted into the target chat as the dispatch message."),
    respondWithTeamId: z
      .string()
      .optional()
      .describe(
        "Agent Team to bind as the conversation's responder. Exactly one of respondWithTeamId / respondWithCharacterId."
      ),
    respondWithCharacterId: z
      .string()
      .optional()
      .describe(
        "Character to bind as the conversation's responder. Exactly one of respondWithTeamId / respondWithCharacterId."
      ),
    memberIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Canonical platform member ids to invite (create-new-chat path only). Resolve emails/phones/names → ids via im_resolve_contact first."
      ),
    existingConversationKey: z
      .string()
      .optional()
      .describe(
        "Target an existing conversation (platform:adapterId:chatId) instead of creating a new chat."
      ),
    adapterId: z
      .string()
      .optional()
      .describe(
        "Bot instance to create the chat as (create-new path). Defaults to the current conversation's bot, or the single capable bot on desktop."
      ),
    startRun: z
      .boolean()
      .optional()
      .describe(
        "Kick off the bound team's run immediately with the brief as its goal. Defaults to true when respondWithTeamId is set; ignored for characters."
      ),
  })
  .refine((v) => Boolean(v.respondWithTeamId) !== Boolean(v.respondWithCharacterId), {
    message: "Provide exactly one responder: respondWithTeamId OR respondWithCharacterId.",
  })

interface ResolvedTarget {
  conversationKey: string
  sessionId: string
  adapterId: string
  conversationRef: ConversationReference
  chatId?: string
  created: boolean
  invalidMemberIds?: string[]
}

/**
 * Resolve where the task lands: an existing bound conversation
 * (`existingConversationKey`) or a freshly created + bootstrapped group chat.
 */
async function resolveTarget(
  args: z.infer<typeof schema>,
  ctx: BuiltInSkillContext
): Promise<ResolvedTarget> {
  if (args.existingConversationKey) {
    const { parseConversationKey } = await import("@/types/connectors/event")
    const parsed = parseConversationKey(args.existingConversationKey)
    const { findSessionByConversationKey } = await import("@/lib/connectors/session-bindings")
    const session = await findSessionByConversationKey(args.existingConversationKey)
    if (!session) {
      throw new Error(
        `Unknown conversation ${args.existingConversationKey} — no bound session exists. Create a new chat instead (omit existingConversationKey) or pass a conversationKey from the Inbox.`
      )
    }
    return {
      conversationKey: args.existingConversationKey,
      sessionId: session.id,
      adapterId: parsed.adapterId,
      conversationRef: session.platformBinding?.conversationRef ?? {
        platform: parsed.platform,
        adapterId: parsed.adapterId,
        channelId: parsed.remoteChatId,
      },
      created: false,
    }
  }

  const resolved = await resolveChatCapableAdapter(ctx, ["chat.create"], args.adapterId)
  const createChat = requireMethod(resolved, "createChat")
  const result = await withScopeCapture(resolved.adapterId, () =>
    createChat({
      name: args.title,
      memberIds: args.memberIds ?? [],
      idempotencyKey: crypto.randomUUID(),
    })
  )
  const { bootstrapConversation } = await import("@/lib/connectors/conversation-bootstrap")
  const bootstrap = await bootstrapConversation({
    platform: resolved.platform,
    adapterId: resolved.adapterId,
    remoteChatId: result.chatId,
    name: args.title,
    source: "im.dispatch_task",
  })
  return {
    conversationKey: bootstrap.conversationKey,
    sessionId: bootstrap.sessionId,
    adapterId: resolved.adapterId,
    conversationRef: {
      platform: resolved.platform,
      adapterId: resolved.adapterId,
      channelId: result.chatId,
    },
    chatId: result.chatId,
    created: true,
    invalidMemberIds: result.invalidMemberIds,
  }
}

const skill: BuiltInSkill<typeof schema> = {
  id: "im.dispatch_task",
  family: "im",
  label: { en: "Dispatch task", "zh-CN": "任务派发" },
  description: {
    en: "Dispatch a sub-task to a dedicated conversation: create a new group chat (or target an existing one), bind an Agent Team or character as its responder, post the task brief, and optionally start the team run immediately.",
    "zh-CN":
      "把子任务派发到专属会话：创建新群聊（或指向既有会话），为其绑定 Agent 团队或角色作为响应者，发布任务简报，并可选立即启动团队运行。",
  },
  platforms: "any",
  // Blast radius: creates chats + rebinds conversation routing + starts team
  // runs — IM channels must allowlist it; desktop invocations are HITL-gated.
  // No `requires`: the existing-conversation path needs no chat-management
  // capability; the create path checks `chat.create` at execute time.
  mutation: "write",
  imAccess: "opt-in",
  mcpToolName: "im_dispatch_task",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const target = await resolveTarget(args, ctx)

    // Bind the responder on the conversation's override row. Only the provided
    // axis is written: binding a team also CLEARS `teamDisabled` (an explicit
    // "no team" veto must not shadow a deliberate dispatch); binding a
    // character leaves `teamDisabled` untouched.
    const { upsertByConversationKey } = await import("@/lib/db/conversation-overrides")
    await upsertByConversationKey({
      conversationKey: target.conversationKey,
      sessionId: target.sessionId,
      ...(args.respondWithTeamId
        ? { teamId: args.respondWithTeamId, teamDisabled: undefined }
        : { characterId: args.respondWithCharacterId }),
    })

    // PII-gate the composed dispatch message before it leaves the device.
    const messageText = `【${args.title}】\n${args.brief}`
    const { hasNoLeakingPiiDeep } = await import("@/lib/twin/ingest/redact")
    let brief: "sent" | "pii_blocked"
    if (!hasNoLeakingPiiDeep(messageText)) {
      // The chat WAS created/bound — report the partial outcome instead of
      // failing the whole call (mirrors im.create_chat's firstMessage path).
      const { appendAudit } = await import("@/lib/connectors/audit")
      await appendAudit({
        adapterId: target.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: target.conversationKey,
        reason: "pii_blocked",
        message: "im.dispatch_task brief rejected by PII gate",
      })
      brief = "pii_blocked"
    } else {
      const { enqueueOutbound } = await import("@/lib/db/outbound-jobs")
      const { newIdempotencyKey } = await import("@/types/connectors/outbound")
      await enqueueOutbound({
        adapterId: target.adapterId,
        conversationKey: target.conversationKey,
        request: {
          conversationRef: target.conversationRef,
          segments: [{ type: "text", text: messageText }],
          metadata: { idempotencyKey: newIdempotencyKey() },
        },
        source: "skill",
      })
      brief = "sent"
    }

    // Auto-run: teams only (a bound character responds to the NEXT inbound in
    // the chat — there is nothing to "start"). A PII-blocked brief also blocks
    // the run: the brief doubles as the team's goal and would reach the model.
    let run: string | undefined
    if (args.respondWithTeamId && args.startRun !== false) {
      if (brief === "pii_blocked") {
        run = "pii_blocked"
      } else {
        const { startTeamRunFromIM } = await import("@/lib/connectors/team-dispatch")
        const res = await startTeamRunFromIM({
          teamId: args.respondWithTeamId,
          goal: args.brief,
          adapterId: target.adapterId,
          conversationKey: target.conversationKey,
          sessionId: target.sessionId,
        })
        run = res.started ? "started" : (res.reason ?? "dispatch_error")
      }
    }

    const { appendAudit } = await import("@/lib/connectors/audit")
    await appendAudit({
      adapterId: target.adapterId,
      kind: "task.dispatched",
      at: Date.now(),
      conversationKey: target.conversationKey,
      fields: {
        conversationKey: target.conversationKey,
        ...(args.respondWithTeamId ? { teamId: args.respondWithTeamId } : {}),
        ...(args.respondWithCharacterId ? { characterId: args.respondWithCharacterId } : {}),
        created: target.created,
        ...(run !== undefined ? { runStarted: run === "started" } : {}),
      },
    })

    return {
      conversationKey: target.conversationKey,
      sessionId: target.sessionId,
      ...(target.chatId ? { chatId: target.chatId } : {}),
      created: target.created,
      bound: args.respondWithTeamId
        ? { teamId: args.respondWithTeamId }
        : { characterId: args.respondWithCharacterId },
      brief,
      ...(run !== undefined ? { run } : {}),
      ...(target.invalidMemberIds?.length ? { invalidMemberIds: target.invalidMemberIds } : {}),
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_im_dispatch_task_${Date.now().toString(36)}`,
      title: "Dispatch task",
      summary: `Dispatch the task "${args.title}" to ${
        args.existingConversationKey
          ? "an existing conversation"
          : `a new group chat with ${args.memberIds?.length ?? 0} member(s)`
      }.`,
      details: [
        {
          label: "Target",
          value: args.existingConversationKey ?? `new chat "${args.title}"`,
        },
        {
          label: "Responder",
          value: args.respondWithTeamId
            ? `team ${args.respondWithTeamId}`
            : `character ${args.respondWithCharacterId ?? ""}`,
        },
        { label: "Brief", value: previewText(args.brief) },
        ...(args.respondWithTeamId
          ? [{ label: "Start run", value: args.startRun !== false ? "immediately" : "no" }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
