/**
 * `issue.delete_project`: remove a delivery container and everything in it.
 *
 * The widest blast radius in the family: `deleteIssueProject` cascades every
 * issue, activity trail, run and the number counter beneath the container. The
 * confirmation card therefore states the issue count, the way the desktop
 * delete dialog does, because "delete Mercury" reads very differently when
 * Mercury holds forty issues.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { projectRefSchema, resolveWorkspaceId } from "./_core"

const schema = z.object({
  issueProject: projectRefSchema,
  confirmIssueCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "How many issues you believe the container holds, from issue_list. The delete is refused when it disagrees, so a stale count cannot take rows you did not know about."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.delete_project",
  family: "issue",
  label: { en: "Delete issue project", "zh-CN": "删除议题项目" },
  description: {
    en: "Permanently delete a delivery container and cascade every issue, activity trail and run inside it. Requires the container's current issue count as a check: call issue_list first and pass what it reports.",
    "zh-CN":
      "永久删除一个交付容器，并级联删除其中所有议题、活动记录与运行记录。需要传入该容器当前的议题数量作为校验：先调用 issue_list，把它报告的数量传进来。",
  },
  platforms: "any",
  mutation: "destructive",
  imAccess: "opt-in",
  mcpToolName: "issue_delete_project",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const { resolveIssueProject } = await import("./_core")
    const project = await resolveIssueProject(args.issueProject, workspaceId)

    const { listIssues } = await import("@/lib/db/issues")
    const held = await listIssues({ projectId: workspaceId, issueProjectId: project.id })
    if (held.length !== args.confirmIssueCount) {
      return {
        status: "refused",
        reason: "count-mismatch",
        key: project.key,
        actualIssueCount: held.length,
        expectedIssueCount: args.confirmIssueCount,
      }
    }

    const { deleteIssueProject } = await import("@/lib/db/issue-projects")
    await deleteIssueProject(project.id)
    return { status: "deleted", id: project.id, key: project.key, deletedIssues: held.length }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_delete_project_${Date.now().toString(36)}`,
      title: "Delete issue project",
      summary: `Permanently delete ${args.issueProject} and the ${args.confirmIssueCount} issue(s) it holds.`,
      details: [{ label: "Cascades", value: "issues, activity trails, runs, number counter" }],
    }),
}

registerBuiltInSkill(skill)
