/**
 * `issue.wakeup_delete`: remove a wakeup for good.
 *
 * Destructive tier like `issue.delete`: a deleted rule and its fire history
 * cannot be brought back, whereas `issue.wakeup_set_enabled` can pause one
 * reversibly.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveWakeupInWorkspace } from "./_wakeup"

const schema = z.object({
  wakeupId: z.string().min(1).describe("The rule, as listed by issue_wakeup_list."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.wakeup_delete",
  family: "issue",
  label: { en: "Delete issue wakeup", "zh-CN": "删除议题唤醒" },
  description: {
    en: "Permanently delete an issue wakeup and its fire history. Prefer issue_wakeup_set_enabled with enabled=false to stop one reversibly.",
    "zh-CN":
      "永久删除一个议题唤醒及其触发记录。若只想可逆地停止，请用 issue_wakeup_set_enabled 并传 enabled=false。",
  },
  platforms: "any",
  mutation: "destructive",
  imAccess: "opt-in",
  mcpToolName: "issue_wakeup_delete",
  inputSchema: schema,
  preflight: async (args, ctx) => {
    await resolveWakeupInWorkspace(args.wakeupId, ctx)
  },
  execute: async (args, ctx) => {
    const { issue } = await resolveWakeupInWorkspace(args.wakeupId, ctx)
    const { deleteIssueWakeup } = await import("@/lib/issues/wakeups/service")
    await deleteIssueWakeup(args.wakeupId, {
      source: "agent",
      sessionId: ctx.sessionId,
      ...(ctx.humanConfirmed ? { humanConfirmed: true } : {}),
    })
    return { status: "deleted", identifier: issue.identifier, wakeupId: args.wakeupId }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_wakeup_delete_${Date.now().toString(36)}`,
      title: "Delete issue wakeup",
      summary: "Delete this wakeup and its fire history. This cannot be undone.",
      details: [{ label: "Wakeup", value: args.wakeupId }],
    }),
}

registerBuiltInSkill(skill)
