/**
 * `issue.update`: every field edit the board offers, in one tool.
 *
 * One tool rather than seven (`issue.set_title`, `issue.move`, `issue.assign`,
 * ...) because `IssueBulkAction` is already the board's single action
 * vocabulary, and each field here is one member of it. Splitting them would
 * fork that vocabulary at the tool layer and make "retitle and reprioritise"
 * two confirmations instead of one.
 *
 * Every field goes through `applyIssueAction`, so the board's capability bits
 * and its run-active guard decide, not this file. Fields are reported
 * individually: a status move can be refused while the retitle beside it
 * lands, and the model has to be told which.
 */

import { z } from "zod"

import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import {
  ISSUE_PRIORITY_VALUES,
  ISSUE_STATUS_VALUES,
  applyIssueAction,
  describeOutcome,
  issueRefSchema,
  resolveIssue,
  resolveIssueActor,
  resolveWorkspaceId,
  summariseIssue,
} from "./_core"

const schema = z.object({
  issue: issueRefSchema,
  title: z.string().min(1).max(200).optional().describe("Replacement title."),
  description: z.string().max(4000).optional().describe("Replacement description."),
  status: z
    .enum(ISSUE_STATUS_VALUES)
    .optional()
    .describe(
      "Board column to move to. Refused while an agent run holds the issue: the runtime owns in_progress until its run settles."
    ),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional().describe("New priority."),
  assignee: z
    .object({
      kind: z.enum(["human", "agent", "team"]).describe("human is the local user."),
      id: z.string().optional().describe("Character id for agent, squad id for team."),
      label: z.string().optional().describe("Display name to cache on the row."),
    })
    .nullable()
    .optional()
    .describe("New assignee. Pass null to clear it."),
  addLabels: z.array(z.string()).optional().describe("Local label ids to add."),
  removeLabels: z.array(z.string()).optional().describe("Local label ids to remove."),
  issueProject: z
    .string()
    .optional()
    .describe("Move the issue to this container (key or id). Must be in the same workspace."),
})

/** Field order is the report order, so it is fixed here rather than by object key order. */
function plannedActions(
  args: z.infer<typeof schema>,
  issueProjectId: string | undefined
): { field: string; action: IssueBulkAction }[] {
  const planned: { field: string; action: IssueBulkAction }[] = []
  if (args.title !== undefined)
    planned.push({ field: "title", action: { kind: "title", to: args.title } })
  if (args.description !== undefined) {
    planned.push({ field: "description", action: { kind: "description", to: args.description } })
  }
  if (args.priority !== undefined) {
    planned.push({ field: "priority", action: { kind: "priority", to: args.priority } })
  }
  if (args.assignee !== undefined) {
    planned.push({ field: "assignee", action: { kind: "assignee", to: args.assignee } })
  }
  for (const labelId of args.addLabels ?? []) {
    planned.push({ field: `addLabel:${labelId}`, action: { kind: "addLabel", labelId } })
  }
  for (const labelId of args.removeLabels ?? []) {
    planned.push({ field: `removeLabel:${labelId}`, action: { kind: "removeLabel", labelId } })
  }
  if (issueProjectId) {
    planned.push({ field: "issueProject", action: { kind: "project", issueProjectId } })
  }
  // Last on purpose: a move is the field most likely to be refused, and the
  // edits beside it should already have landed when it is.
  if (args.status !== undefined) {
    planned.push({ field: "status", action: { kind: "status", to: args.status } })
  }
  return planned
}

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.update",
  family: "issue",
  label: { en: "Update issue", "zh-CN": "更新议题" },
  description: {
    en: "Edit an issue: title, description, status column, priority, assignee, labels, or which delivery container holds it. Supply only the fields to change. Each is applied through the board's own guard and reported separately, so some may be refused while others land.",
    "zh-CN":
      "修改议题的标题、描述、状态列、优先级、负责人、标签或所属交付容器。只传需要改的字段。每个字段都会经过看板自身的守卫逐一执行并分别回报，可能出现部分成功、部分被拒。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_update",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const issue = await resolveIssue(args.issue, workspaceId)
    const by = await resolveIssueActor(ctx)

    let issueProjectId: string | undefined
    if (args.issueProject) {
      const { resolveIssueProject } = await import("./_core")
      issueProjectId = (await resolveIssueProject(args.issueProject, workspaceId)).id
    }

    const planned = plannedActions(args, issueProjectId)
    if (planned.length === 0) {
      return { status: "no-op", issue: summariseIssue(issue), results: [] }
    }

    const results = []
    for (const { field, action } of planned) {
      // Re-read between actions: each write bumps the row, and the run guard
      // reads live state. A stale snapshot would let a refused move look legal.
      const current = await resolveIssue(issue.id, workspaceId)
      results.push(describeOutcome(await applyIssueAction(current, action, by), field))
    }

    const after = await resolveIssue(issue.id, workspaceId)
    return {
      status: results.every((r) => r.status === "applied") ? "applied" : "partial",
      issue: summariseIssue(after),
      results,
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_update_${Date.now().toString(36)}`,
      title: "Update issue",
      summary: `Edit ${args.issue}.`,
      details: [
        ...(args.title ? [{ label: "Title", value: args.title }] : []),
        ...(args.status ? [{ label: "Status", value: args.status }] : []),
        ...(args.priority ? [{ label: "Priority", value: args.priority }] : []),
        ...(args.assignee !== undefined
          ? [
              {
                label: "Assignee",
                value: args.assignee
                  ? (args.assignee.label ?? `${args.assignee.kind}:${args.assignee.id ?? "?"}`)
                  : "Unassigned",
              },
            ]
          : []),
        ...(args.issueProject ? [{ label: "Project", value: args.issueProject }] : []),
        ...(args.description
          ? [{ label: "Description", value: args.description.slice(0, 200) }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
