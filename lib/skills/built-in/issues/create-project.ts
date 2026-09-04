/**
 * `issue.create_project`: open a delivery container.
 *
 * Until this existed a workspace could hold exactly one container in practice:
 * the only `createIssueProject` caller reachable from a conversation was the
 * create-issue dialog's empty-board branch, so an assistant asked to "start a
 * board for the Q3 migration" had nothing to call.
 *
 * `key` is the printed prefix on every identifier the container ever mints and
 * is immutable afterwards, so it is derived from the name unless the caller
 * insists, and validated either way.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { ISSUE_PRIORITY_VALUES, resolveIssueActor, resolveWorkspaceId } from "./_core"

const PROJECT_STATUS_VALUES = [
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "canceled",
] as const

const schema = z.object({
  name: z.string().min(1).max(120).describe("Display name, e.g. 'Mercury Platform'."),
  key: z
    .string()
    .min(2)
    .max(5)
    .optional()
    .describe(
      "Identifier prefix, 2 to 5 letters, e.g. 'MERC' giving MERC-1. Derived from the name when omitted. Immutable once set, and unique across every workspace."
    ),
  description: z
    .string()
    .max(4000)
    .optional()
    .describe("What this container delivers. Shared with agents as task context."),
  status: z
    .enum(PROJECT_STATUS_VALUES)
    .optional()
    .describe("Lifecycle state. Defaults to backlog."),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional(),
  targetDate: z.number().int().optional().describe("Target date as a unix epoch in milliseconds."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.create_project",
  family: "issue",
  label: { en: "Create issue project", "zh-CN": "创建议题项目" },
  description: {
    en: "Create a delivery container (an issue project) in the active workspace. Its key becomes the prefix of every issue identifier it mints and cannot be changed afterwards. Returns the id that issue_create accepts.",
    "zh-CN":
      "在当前工作区创建一个交付容器（议题项目）。它的 key 会成为其下所有议题编号的前缀，创建后不可更改。返回可直接用于 issue_create 的 id。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_create_project",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const lead = await resolveIssueActor(ctx)
    const { createIssueProject } = await import("@/lib/db/issue-projects")

    try {
      const project = await createIssueProject({
        projectId: workspaceId,
        name: args.name,
        ...(args.key ? { key: args.key.toUpperCase() } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.status ? { status: args.status } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.targetDate ? { targetDate: args.targetDate } : {}),
        lead,
      })
      return {
        status: "created",
        id: project.id,
        key: project.key,
        name: project.name,
        workspaceId,
      }
    } catch (error) {
      // Key collisions are the expected failure here and are the model's to
      // resolve by picking another one, so they come back as an answer.
      const message = error instanceof Error ? error.message : String(error)
      return { status: "refused", reason: message }
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_create_project_${Date.now().toString(36)}`,
      title: "Create issue project",
      summary: `Open a delivery container named "${args.name}".`,
      details: [
        ...(args.key ? [{ label: "Key", value: args.key.toUpperCase() }] : []),
        ...(args.description
          ? [{ label: "Description", value: args.description.slice(0, 200) }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
