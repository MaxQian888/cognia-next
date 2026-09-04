/**
 * `issue.get`: one issue in full. Its fields, its container, the tail of its
 * activity trail, its runs, and which engines could take it right now.
 *
 * Read-only, and deliberately one round trip. An assistant deciding what to do
 * with an issue needs all four of those at once, and asking for them
 * separately is three extra turns for facts that always travel together.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { issueRefSchema, resolveIssue, resolveWorkspaceId, summariseIssue } from "./_core"

const schema = z.object({
  issue: issueRefSchema,
  activityLimit: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("How many of the most recent trail entries to include. Defaults to 10."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.get",
  family: "issue",
  label: { en: "Get issue", "zh-CN": "查看议题" },
  description: {
    en: "Fetch one issue by identifier (e.g. MERC-12) or id, with its delivery container, recent activity, run history and the engines that could run it now. Use before editing so the reported state is current.",
    "zh-CN":
      "按编号（如 MERC-12）或 id 获取单个议题，附带所属交付容器、最近活动、运行记录，以及当前可以承接它的执行引擎。修改前先调用，确保状态是最新的。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "issue_get",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const issue = await resolveIssue(args.issue, workspaceId)

    const { getIssueProject } = await import("@/lib/db/issue-projects")
    const { listIssueEvents } = await import("@/lib/db/issue-events")
    const { listIssueRuns } = await import("@/lib/db/issue-runs")
    const { listIssueRunOptions } = await import("@/lib/issues/run/registry")

    const [container, events, runs, options] = await Promise.all([
      getIssueProject(issue.issueProjectId),
      listIssueEvents({ issueId: issue.id, descending: true, limit: args.activityLimit ?? 10 }),
      listIssueRuns({ issueId: issue.id }),
      // Never let a misbehaving adapter turn a read into a failure.
      listIssueRunOptions(issue.id).catch(() => []),
    ])

    return {
      workspaceId,
      issue: summariseIssue(issue),
      issueProject: container
        ? { id: container.id, key: container.key, name: container.name, status: container.status }
        : null,
      activity: events.map((event) => ({ kind: event.kind, ts: event.ts, payload: event.payload })),
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        adapterId: run.adapterId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt ?? null,
        artifacts: run.artifacts,
        summary: run.summary ?? null,
        error: run.error ?? null,
      })),
      runnableBy: options
        .filter((option) => option.verdict.ok)
        .map((option) => ({ adapterId: option.adapter.id, kind: option.adapter.kind })),
    }
  },
}

registerBuiltInSkill(skill)
