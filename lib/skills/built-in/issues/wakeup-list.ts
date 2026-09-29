/**
 * `issue.wakeup_list`: the wakeups on one issue, or on every issue in the
 * workspace. Includes the platform-owned "sub-issues finished" rules and why
 * any rule stopped (`pauseReason`: loop, rate, issue-closed, manual).
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { issueRefSchema, resolveIssue, resolveWorkspaceId } from "./_core"

const schema = z.object({
  issue: issueRefSchema
    .optional()
    .describe("Only this issue's rules. Omit for the whole workspace."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.wakeup_list",
  family: "issue",
  label: { en: "List issue wakeups", "zh-CN": "列出议题唤醒" },
  description: {
    en: "List issue wakeups with their trigger, instruction, status, fire count and, for a paused rule, why it paused. Use it before pausing or deleting one, and to find the wakeupId a periodic run checks in with.",
    "zh-CN":
      "列出议题唤醒规则：触发条件、指令、状态、已触发次数，以及暂停规则的暂停原因。暂停或删除前先调用它，也可用它查到周期运行签到所需的 wakeupId。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "issue_wakeup_list",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const [{ listIssueWakeups, listWorkspaceIssueWakeups }, { summariseWakeup }] =
      await Promise.all([
        import("@/lib/issues/wakeups/service"),
        import("@/lib/issues/wakeups/model"),
      ])
    if (args.issue) {
      const issue = await resolveIssue(args.issue, workspaceId)
      const tasks = await listIssueWakeups(issue.id)
      return { identifier: issue.identifier, wakeups: tasks.map(summariseWakeup) }
    }
    const tasks = await listWorkspaceIssueWakeups(workspaceId)
    return { wakeups: tasks.map(summariseWakeup) }
  },
}

registerBuiltInSkill(skill)
