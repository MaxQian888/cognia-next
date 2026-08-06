/**
 * `im.create_chat` — agent-invoked group-chat creation (W2 multi-bot).
 *
 * Platform-neutral: routes through the bound adapter instance's optional
 * `createChat()` method (gated by the `chat.create` capability flag), then
 * pre-mints the local conversation (`bootstrapConversation`) so the new chat
 * shows in the Inbox and future inbound converges, and optionally delivers a
 * PII-gated first message through the durable outbound queue.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { previewText, requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const schema = z.object({
  name: z.string().min(1).describe("Display name for the new group chat."),
  memberIds: z
    .array(z.string().min(1))
    .describe(
      "Canonical platform member ids to invite (e.g. Lark open_ids). Resolve emails/phones/names → ids via im_resolve_contact first."
    ),
  description: z.string().optional().describe("Optional chat description."),
  firstMessage: z
    .string()
    .optional()
    .describe("Optional first message to send into the new chat after creation."),
  adapterId: z
    .string()
    .optional()
    .describe(
      "Bot instance to create the chat as. Defaults to the current conversation's bot, or the single capable bot on desktop."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "im.create_chat",
  family: "im",
  label: { en: "Create group chat", "zh-CN": "创建群聊" },
  description: {
    en: "Create a new group chat on the connected IM platform, invite members, and optionally send a first message. Returns the new chatId + conversationKey and any member ids the platform rejected.",
    "zh-CN":
      "在已连接的 IM 平台上创建新群聊、邀请成员，并可选发送第一条消息。返回新 chatId、conversationKey 及平台拒绝的成员 id。",
  },
  platforms: "any",
  requires: ["chat.create"],
  mutation: "write",
  imAccess: "always",
  mcpToolName: "im_create_chat",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const resolved = await resolveChatCapableAdapter(ctx, ["chat.create"], args.adapterId)
    const createChat = requireMethod(resolved, "createChat")

    const result = await withScopeCapture(resolved.adapterId, () =>
      createChat({
        name: args.name,
        memberIds: args.memberIds,
        description: args.description,
        idempotencyKey: crypto.randomUUID(),
      })
    )

    const { bootstrapConversation } = await import("@/lib/connectors/conversation-bootstrap")
    const bootstrap = await bootstrapConversation({
      platform: resolved.platform,
      adapterId: resolved.adapterId,
      remoteChatId: result.chatId,
      name: args.name,
      source: "im.create_chat",
    })

    let firstMessage: "sent" | "pii_blocked" | undefined
    if (args.firstMessage?.trim()) {
      const { hasNoLeakingPiiDeep } = await import("@cognia/redact")
      if (!hasNoLeakingPiiDeep(args.firstMessage)) {
        // The chat WAS created — report the partial outcome instead of
        // failing the whole call.
        const { appendAudit } = await import("@/lib/connectors/audit")
        await appendAudit({
          adapterId: resolved.adapterId,
          kind: "adapter.error",
          at: Date.now(),
          conversationKey: bootstrap.conversationKey,
          reason: "pii_blocked",
          message: "im.create_chat first message rejected by PII gate",
        })
        firstMessage = "pii_blocked"
      } else {
        const { enqueueGoverned: enqueueOutbound } =
          await import("@/lib/connectors/delivery-gateway")
        const { newIdempotencyKey } = await import("@/types/connectors/outbound")
        await enqueueOutbound({
          adapterId: resolved.adapterId,
          conversationKey: bootstrap.conversationKey,
          request: {
            conversationRef: {
              platform: resolved.platform,
              adapterId: resolved.adapterId,
              channelId: result.chatId,
            },
            segments: [{ type: "text", text: args.firstMessage }],
            metadata: { idempotencyKey: newIdempotencyKey() },
          },
          source: "skill",
        })
        firstMessage = "sent"
      }
    }

    return {
      chatId: result.chatId,
      conversationKey: bootstrap.conversationKey,
      sessionId: bootstrap.sessionId,
      ...(result.invalidMemberIds?.length ? { invalidMemberIds: result.invalidMemberIds } : {}),
      ...(firstMessage ? { firstMessage } : {}),
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_im_create_chat_${Date.now().toString(36)}`,
      title: "Create group chat",
      summary: `Create the group chat "${args.name}" and invite ${args.memberIds.length} member(s).`,
      details: [
        { label: "Members", value: args.memberIds.join(", ") || "(none)" },
        ...(args.description ? [{ label: "Description", value: args.description }] : []),
        ...(args.firstMessage
          ? [{ label: "First message", value: previewText(args.firstMessage) }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
