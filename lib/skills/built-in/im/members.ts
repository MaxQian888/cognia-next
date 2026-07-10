/**
 * `im.invite_members` / `im.remove_members` — group membership management
 * (W2 multi-bot). Platform-neutral via the adapter's optional
 * `addChatMembers` / `removeChatMembers` methods (`chat.members` flag).
 * Both report per-id partial failures instead of all-or-nothing.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const schema = z.object({
  chatId: z
    .string()
    .optional()
    .describe(
      "Platform chat id (e.g. Lark oc_…). Defaults to the current IM conversation's chat when invoked from one."
    ),
  memberIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Canonical platform member ids (resolve emails/phones/names → ids via im_resolve_contact first)."
    ),
  adapterId: z
    .string()
    .optional()
    .describe("Bot instance to act as. Defaults to the current conversation's bot."),
})

async function resolveChatId(
  explicit: string | undefined,
  ctxConversationKey: string | undefined
): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  if (ctxConversationKey) {
    const { parseConversationKey } = await import("@/types/connectors/event")
    return parseConversationKey(ctxConversationKey).remoteChatId
  }
  throw new Error(
    "chatId is required outside an IM conversation — pass the platform chat id explicitly."
  )
}

function mkMemberSkill(input: {
  id: "im.invite_members" | "im.remove_members"
  mcpToolName: string
  method: "addChatMembers" | "removeChatMembers"
  mutation: "write" | "destructive"
  imAccess: "always" | "opt-in"
  label: { en: string; "zh-CN": string }
  description: { en: string; "zh-CN": string }
  confirmVerb: string
}): BuiltInSkill<typeof schema> {
  return {
    id: input.id,
    family: "im",
    label: input.label,
    description: input.description,
    platforms: "any",
    requires: ["chat.members"],
    mutation: input.mutation,
    imAccess: input.imAccess,
    mcpToolName: input.mcpToolName,
    inputSchema: schema,
    execute: async (args, ctx) => {
      const resolved = await resolveChatCapableAdapter(ctx, ["chat.members"], args.adapterId)
      const fn = requireMethod(resolved, input.method)
      const chatId = await resolveChatId(args.chatId, ctx.imBinding?.conversationKey)
      return withScopeCapture(resolved.adapterId, () => fn({ chatId, memberIds: args.memberIds }))
    },
    hitlSurface: (args) =>
      buildConfirmSurface({
        surfaceId: `sfc_${input.id.replace(/\./g, "_")}_${Date.now().toString(36)}`,
        title: input.label.en,
        summary: `${input.confirmVerb} ${args.memberIds.length} member(s)${args.chatId ? ` in chat ${args.chatId}` : " in this chat"}.`,
        details: [{ label: "Members", value: args.memberIds.join(", ") }],
      }),
  }
}

registerBuiltInSkill(
  mkMemberSkill({
    id: "im.invite_members",
    mcpToolName: "im_invite_members",
    method: "addChatMembers",
    mutation: "write",
    imAccess: "always",
    label: { en: "Invite chat members", "zh-CN": "邀请群成员" },
    description: {
      en: "Invite members into a group chat on the connected IM platform. Reports per-member partial failures.",
      "zh-CN": "邀请成员加入 IM 平台群聊。按成员返回部分失败结果。",
    },
    confirmVerb: "Invite",
  })
)

registerBuiltInSkill(
  mkMemberSkill({
    id: "im.remove_members",
    mcpToolName: "im_remove_members",
    method: "removeChatMembers",
    // Kicking people out of a chat is not undoable by the bot — destructive
    // tier: HITL always, and IM channels must allowlist the skill id.
    mutation: "destructive",
    imAccess: "opt-in",
    label: { en: "Remove chat members", "zh-CN": "移除群成员" },
    description: {
      en: "Remove members from a group chat on the connected IM platform. Reports per-member partial failures.",
      "zh-CN": "从 IM 平台群聊移除成员。按成员返回部分失败结果。",
    },
    confirmVerb: "Remove",
  })
)
