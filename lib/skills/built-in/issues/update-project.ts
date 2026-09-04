/**
 * `issue.update_project`: amend a delivery container.
 *
 * `key` is absent from the schema on purpose, mirroring
 * `IssueProjectUpdatePatch`: it is printed into every identifier the container
 * has already minted, and into whatever commits and chat messages quoted them.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { ISSUE_PRIORITY_VALUES, projectRefSchema, resolveWorkspaceId } from "./_core"

const PROJECT_STATUS_VALUES = [
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "canceled",
] as const

const schema = z.object({
  issueProject: projectRefSchema,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(PROJECT_STATUS_VALUES).optional(),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional(),
  targetDate: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Target date as a unix epoch in milliseconds. Pass null to clear it."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.update_project",
  family: "issue",
  label: { en: "Update issue project", "zh-CN": "更新议题项目" },
  description: {
    en: "Amend a delivery container's name, description, lifecycle status, priority or target date. The key cannot be changed: it is baked into every identifier the container has already issued.",
    "zh-CN":
      "修改交付容器的名称、描述、生命周期状态、优先级或目标日期。key 不可更改，它已经写进该容器发出的所有议题编号里。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_update_project",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const { resolveIssueProject } = await import("./_core")
    const project = await resolveIssueProject(args.issueProject, workspaceId)

    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.targetDate !== undefined ? { targetDate: args.targetDate } : {}),
    }
    if (Object.keys(patch).length === 0) {
      return { status: "no-op", id: project.id, key: project.key }
    }

    const { updateIssueProject, getIssueProject } = await import("@/lib/db/issue-projects")
    await updateIssueProject(project.id, patch)
    const after = await getIssueProject(project.id)
    return {
      status: "updated",
      id: project.id,
      key: project.key,
      name: after?.name ?? project.name,
      projectStatus: after?.status ?? project.status,
      fields: Object.keys(patch),
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_update_project_${Date.now().toString(36)}`,
      title: "Update issue project",
      summary: `Amend ${args.issueProject}.`,
      details: [
        ...(args.name ? [{ label: "Name", value: args.name }] : []),
        ...(args.status ? [{ label: "Status", value: args.status }] : []),
        ...(args.priority ? [{ label: "Priority", value: args.priority }] : []),
      ],
    }),
}

registerBuiltInSkill(skill)
