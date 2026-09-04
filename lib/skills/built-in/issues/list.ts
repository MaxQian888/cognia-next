/**
 * `issue.list`: the board, as the assistant sees it. Read-only.
 *
 * Local rows only, matching `lib/global-search/providers/issues.ts`: federated
 * GitHub mirrors and agent-engine rows have their own tools and their own
 * surfaces, and returning them here would offer the model work items it has no
 * write path to.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import {
  ISSUE_PRIORITY_VALUES,
  ISSUE_STATUS_VALUES,
  resolveWorkspaceId,
  summariseIssue,
} from "./_core"

const schema = z.object({
  status: z
    .array(z.enum(ISSUE_STATUS_VALUES))
    .optional()
    .describe("Keep only these board columns. Omit for every column."),
  priority: z
    .array(z.enum(ISSUE_PRIORITY_VALUES))
    .optional()
    .describe("Keep only these priorities."),
  issueProject: z
    .string()
    .optional()
    .describe("Delivery container key or id. Omit to span every container in the workspace."),
  assignee: z
    .enum(["me", "agents", "unassigned", "any"])
    .optional()
    .describe(
      "Who the issue is on. 'agents' covers both agent and squad assignees. Defaults to 'any'."
    ),
  query: z.string().optional().describe("Case-insensitive match on identifier, title or body."),
  limit: z.number().int().min(1).max(100).optional().describe("Rows to return. Defaults to 25."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.list",
  family: "issue",
  label: { en: "List issues", "zh-CN": "列出议题" },
  description: {
    en: "List issues on the local board for the active workspace, filtered by column, priority, container, assignee or free text. Returns identifiers (e.g. MERC-12) that every other issue tool accepts.",
    "zh-CN":
      "列出当前工作区本地看板上的议题，可按状态列、优先级、交付容器、负责人或关键词过滤。返回的编号（如 MERC-12）可直接用于其他议题工具。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "issue_list",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const { listIssues } = await import("@/lib/db/issues")
    const workspaceId = await resolveWorkspaceId(ctx)

    let issueProjectId: string | undefined
    if (args.issueProject) {
      const { resolveIssueProject } = await import("./_core")
      issueProjectId = (await resolveIssueProject(args.issueProject, workspaceId)).id
    }

    const needle = args.query?.trim().toLowerCase()
    const priorities = args.priority?.length ? new Set<string>(args.priority) : undefined
    const rows = (
      await listIssues({
        projectId: workspaceId,
        ...(issueProjectId ? { issueProjectId } : {}),
        ...(args.status?.length ? { statuses: args.status } : {}),
      })
    ).filter((row) => {
      if (priorities && !priorities.has(row.priority)) return false
      switch (args.assignee) {
        case "me":
          if (row.assigneeKind !== "human") return false
          break
        case "agents":
          if (row.assigneeKind !== "agent" && row.assigneeKind !== "team") return false
          break
        case "unassigned":
          if (row.assigneeKind !== undefined) return false
          break
        default:
          break
      }
      if (!needle) return true
      return (
        row.identifier.toLowerCase().includes(needle) ||
        row.title.toLowerCase().includes(needle) ||
        (row.description?.toLowerCase().includes(needle) ?? false)
      )
    })

    const limit = args.limit ?? 25
    return {
      workspaceId,
      total: rows.length,
      returned: Math.min(rows.length, limit),
      issues: rows.slice(0, limit).map(summariseIssue),
    }
  },
}

registerBuiltInSkill(skill)
