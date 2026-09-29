/**
 * `issue.wakeup_set_enabled`: pause a wakeup, or resume a paused one.
 *
 * Resuming is also how a rule that paused itself (a loop between agents, too
 * many fires in an hour) comes back, once whatever caused it is fixed. A rule
 * on a finished issue cannot be resumed: finishing stopped it on purpose.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveWakeupInWorkspace } from "./_wakeup"

const schema = z.object({
  wakeupId: z.string().min(1).describe("The rule, as listed by issue_wakeup_list."),
  enabled: z.boolean().describe("false pauses the rule; true resumes it."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.wakeup_set_enabled",
  family: "issue",
  label: { en: "Pause or resume issue wakeup", "zh-CN": "暂停或恢复议题唤醒" },
  description: {
    en: "Pause an issue wakeup, or resume a paused one (including one that paused itself for looping or firing too often). Resuming is refused while the issue is finished.",
    "zh-CN":
      "暂停一个议题唤醒，或恢复已暂停的唤醒（包括因循环或触发过频而自动暂停的）。议题已结束时不能恢复。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_wakeup_set_enabled",
  inputSchema: schema,
  preflight: async (args, ctx) => {
    await resolveWakeupInWorkspace(args.wakeupId, ctx)
  },
  execute: async (args, ctx) => {
    const { issue } = await resolveWakeupInWorkspace(args.wakeupId, ctx)
    const [{ setIssueWakeupEnabled }, { summariseWakeup }] = await Promise.all([
      import("@/lib/issues/wakeups/service"),
      import("@/lib/issues/wakeups/model"),
    ])
    const task = await setIssueWakeupEnabled(args.wakeupId, args.enabled, {
      source: "agent",
      sessionId: ctx.sessionId,
      ...(ctx.humanConfirmed ? { humanConfirmed: true } : {}),
    })
    return {
      status: args.enabled ? "resumed" : "paused",
      identifier: issue.identifier,
      wakeup: summariseWakeup(task),
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_wakeup_set_enabled_${Date.now().toString(36)}`,
      title: args.enabled ? "Resume issue wakeup" : "Pause issue wakeup",
      summary: args.enabled
        ? "Let this wakeup fire again."
        : "Stop this wakeup until it is resumed.",
      details: [{ label: "Wakeup", value: args.wakeupId }],
    }),
}

registerBuiltInSkill(skill)
