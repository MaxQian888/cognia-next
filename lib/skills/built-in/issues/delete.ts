/**
 * `issue.delete`: remove one issue, its trail and its runs.
 *
 * `destructive`, so the dispatcher always confirms and an IM channel must
 * name the skill in `allowedBuiltInSkillIds` before it is even offered. The
 * identifier is burned either way: numbers are never reused, so a deleted
 * MERC-12 does not come back when the next issue is filed.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import {
  applyIssueAction,
  issueRefSchema,
  resolveIssue,
  resolveIssueActor,
  resolveWorkspaceId,
} from "./_core"

const schema = z.object({
  issue: issueRefSchema,
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.delete",
  family: "issue",
  label: { en: "Delete issue", "zh-CN": "删除议题" },
  description: {
    en: "Permanently delete one issue together with its activity trail and run records. The identifier is not reused. Prefer moving the issue to the canceled column when the intent is to close it rather than erase it.",
    "zh-CN":
      "永久删除一个议题及其活动记录与运行记录，编号不会被重新使用。若只是想关闭议题，请改用把它移到 canceled 列。",
  },
  platforms: "any",
  mutation: "destructive",
  imAccess: "opt-in",
  mcpToolName: "issue_delete",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const issue = await resolveIssue(args.issue, workspaceId)
    const by = await resolveIssueActor(ctx)

    const outcome = await applyIssueAction(issue, { kind: "delete" }, by)
    if (outcome.applied === 0) {
      return {
        status: "refused",
        reason: outcome.reason ?? "unknown",
        identifier: issue.identifier,
      }
    }
    return { status: "deleted", identifier: issue.identifier, id: issue.id }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_delete_${Date.now().toString(36)}`,
      title: "Delete issue",
      summary: `Permanently delete ${args.issue}, its activity trail and its run records.`,
      details: [],
    }),
}

registerBuiltInSkill(skill)
