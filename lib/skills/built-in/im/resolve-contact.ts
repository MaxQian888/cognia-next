/**
 * `im.resolve_contact` — turn emails / phone numbers / names into canonical
 * platform member ids (W2 multi-bot). Read tier, no HITL. Platform-neutral
 * via the adapter's optional `resolveContacts` (`contact.resolve`).
 *
 * Feeds `memberIds` for im_create_chat / im_invite_members / im_remove_members.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const schema = z
  .object({
    emails: z.array(z.string().min(3)).optional().describe("Emails to resolve (exact match)."),
    phones: z
      .array(z.string().min(5))
      .optional()
      .describe("Phone numbers to resolve (exact match, include country code)."),
    query: z
      .string()
      .optional()
      .describe(
        "Free-text name search. Platform-dependent: on Lark it needs the bot's connected user OAuth identity; prefer emails/phones when known."
      ),
    adapterId: z.string().optional().describe("Bot instance to resolve against."),
  })
  .refine((v) => (v.emails?.length ?? 0) > 0 || (v.phones?.length ?? 0) > 0 || !!v.query?.trim(), {
    message: "Provide at least one of emails / phones / query.",
  })

const skill: BuiltInSkill<typeof schema> = {
  id: "im.resolve_contact",
  family: "im",
  label: { en: "Resolve contacts", "zh-CN": "解析联系人" },
  description: {
    en: "Resolve emails, phone numbers, or a name query into canonical platform member ids (for inviting into chats). Returns candidates with exact/fuzzy confidence.",
    "zh-CN": "把邮箱、手机号或姓名解析为平台成员 id（用于拉群/邀请）。返回精确/模糊置信度的候选。",
  },
  platforms: "any",
  requires: ["contact.resolve"],
  mutation: "read",
  imAccess: "always",
  mcpToolName: "im_resolve_contact",
  inputSchema: schema,
  // The lookup keys ARE contact identifiers headed to the platform's own
  // directory API — without this the dispatcher's email detector blocks the
  // skill's entire purpose. `adapterId` (the only other field) stays scanned.
  piiArgFields: ["emails", "phones", "query"],
  execute: async (args, ctx) => {
    const resolved = await resolveChatCapableAdapter(ctx, ["contact.resolve"], args.adapterId)
    const resolveContacts = requireMethod(resolved, "resolveContacts")
    const candidates = await withScopeCapture(resolved.adapterId, () =>
      resolveContacts({ emails: args.emails, phones: args.phones, query: args.query })
    )
    return { candidates }
  },
}

registerBuiltInSkill(skill)
