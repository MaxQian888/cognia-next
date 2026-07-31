/**
 * `im.update_chat` — rename / re-describe a group chat (W2 multi-bot).
 * Platform-neutral via the adapter's optional `updateChat` (`chat.update`).
 * v1 covers name + description; group announcement is a documented follow-up
 * (Lark's modern announcement is a docx-backed CCM document).
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const schema = z
  .object({
    chatId: z
      .string()
      .optional()
      .describe("Platform chat id. Defaults to the current IM conversation's chat."),
    name: z.string().optional().describe("New chat display name."),
    description: z.string().optional().describe("New chat description."),
    adapterId: z.string().optional().describe("Bot instance to act as."),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: "Provide at least one of name / description.",
  })

const skill: BuiltInSkill<typeof schema> = {
  id: "im.update_chat",
  family: "im",
  label: { en: "Update group chat", "zh-CN": "修改群信息" },
  description: {
    en: "Rename a group chat and/or update its description on the connected IM platform.",
    "zh-CN": "修改 IM 平台群聊的群名和/或群描述。",
  },
  platforms: "any",
  requires: ["chat.update"],
  mutation: "write",
  imAccess: "always",
  mcpToolName: "im_update_chat",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const resolved = await resolveChatCapableAdapter(ctx, ["chat.update"], args.adapterId)
    const updateChat = requireMethod(resolved, "updateChat")
    let chatId = args.chatId?.trim()
    if (!chatId) {
      if (!ctx.imBinding?.conversationKey) {
        throw new Error(
          "chatId is required outside an IM conversation — pass the platform chat id explicitly."
        )
      }
      const { parseConversationKey } = await import("@/types/connectors/event")
      chatId = parseConversationKey(ctx.imBinding.conversationKey).remoteChatId
    }
    await withScopeCapture(resolved.adapterId, () =>
      updateChat({ chatId: chatId as string, name: args.name, description: args.description })
    )
    return { chatId, updated: true }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_im_update_chat_${Date.now().toString(36)}`,
      title: "Update group chat",
      summary: `Update ${args.chatId ? `chat ${args.chatId}` : "this chat"}.`,
      details: [
        ...(args.name !== undefined ? [{ label: "New name", value: args.name }] : []),
        ...(args.description !== undefined
          ? [{ label: "New description", value: args.description }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
