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
  cycle: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Cycle or milestone id to plan the issue into. Pass null to take it out of its cycle."
    ),
  dueDate: z
    .string()
    .nullable()
    .optional()
    .describe("Due date as YYYY-MM-DD. Pass null to clear it."),
  estimate: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe("Effort in points. Pass null to clear it."),
  parent: z
    .string()
    .nullable()
    .optional()
    .describe("Parent issue (identifier or id) to make this a sub-issue of. Pass null to detach."),
  addBlockers: z
    .array(z.string())
    .optional()
    .describe("Issues (identifier or id) that must finish before this one."),
  removeBlockers: z.array(z.string()).optional().describe("Blockers to remove (identifier or id)."),
})

function parseDueDate(value: string): number {
  const [y, m, d] = value.split("-").map(Number)
  if (!y || !m || !d) throw new Error(`dueDate must be YYYY-MM-DD, got ${JSON.stringify(value)}`)
  return new Date(y, m - 1, d, 12).getTime()
}

/** Field order is the report order, so it is fixed here rather than by object key order. */
function plannedActions(
  args: z.infer<typeof schema>,
  issueProjectId: string | undefined,
  resolved: { parentId?: string | null; addBlockerIds: string[]; removeBlockerIds: string[] } = {
    addBlockerIds: [],
    removeBlockerIds: [],
  }
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
  if (args.cycle !== undefined) {
    planned.push({ field: "cycle", action: { kind: "cycle", cycleId: args.cycle } })
  }
  if (args.dueDate !== undefined) {
    planned.push({
      field: "dueDate",
      action: { kind: "dueDate", to: args.dueDate === null ? null : parseDueDate(args.dueDate) },
    })
  }
  if (args.estimate !== undefined) {
    planned.push({ field: "estimate", action: { kind: "estimate", to: args.estimate } })
  }
  if (resolved.parentId !== undefined) {
    planned.push({ field: "parent", action: { kind: "parent", parentId: resolved.parentId } })
  }
  for (const blockerId of resolved.addBlockerIds) {
    planned.push({ field: `addBlocker:${blockerId}`, action: { kind: "addBlocker", blockerId } })
  }
  for (const blockerId of resolved.removeBlockerIds) {
    planned.push({
      field: `removeBlocker:${blockerId}`,
      action: { kind: "removeBlocker", blockerId },
    })
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
    en: "Edit an issue: title, description, status column, priority, assignee, labels, delivery container, cycle, due date, estimate, parent issue or blockers. Supply only the fields to change. Each is applied through the board's own guard and reported separately, so some may be refused while others land.",
    "zh-CN":
      "修改议题的标题、描述、状态列、优先级、负责人、标签、所属交付容器、迭代、截止日期、估点、父议题或阻塞项。只传需要改的字段。每个字段都会经过看板自身的守卫逐一执行并分别回报，可能出现部分成功、部分被拒。",
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

    // Relations name other issues by identifier, so they are resolved (and
    // scope-checked) up front, the way the container is.
    const resolved: {
      parentId?: string | null
      addBlockerIds: string[]
      removeBlockerIds: string[]
    } = {
      addBlockerIds: [],
      removeBlockerIds: [],
    }
    if (args.parent !== undefined) {
      resolved.parentId =
        args.parent === null ? null : (await resolveIssue(args.parent, workspaceId)).id
    }
    for (const ref of args.addBlockers ?? []) {
      resolved.addBlockerIds.push((await resolveIssue(ref, workspaceId)).id)
    }
    for (const ref of args.removeBlockers ?? []) {
      resolved.removeBlockerIds.push((await resolveIssue(ref, workspaceId)).id)
    }

    const planned = plannedActions(args, issueProjectId, resolved)
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
