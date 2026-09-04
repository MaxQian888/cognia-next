/**
 * `issue.run`: hand an issue to an execution engine.
 *
 * The run bridge (ADR-0132 section 2) was fully built and had no agent-facing
 * door at all: an assistant could file work and describe work but never start
 * it. `startIssueRun` is refuse-or-dispatch, so the adapter's own `canRun`
 * verdict decides, and a refusal comes back as an answer rather than an error.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { issueRefSchema, resolveIssue, resolveIssueActor, resolveWorkspaceId } from "./_core"

const schema = z.object({
  issue: issueRefSchema,
  adapterId: z
    .string()
    .optional()
    .describe(
      "Engine to dispatch to. Omit to take the first engine that accepts the issue. `issue_get` lists the accepting engines under `runnableBy`."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.run",
  family: "issue",
  label: { en: "Run issue", "zh-CN": "执行议题" },
  description: {
    en: "Dispatch an issue to an execution engine (a local agent task, a squad, or the GitHub loop). The issue moves to in_progress while the run is in flight and parks at in_review when it settles. Returns the run id, or the engine's reason for refusing.",
    "zh-CN":
      "把议题派发给执行引擎（本地 agent 任务、小队或 GitHub 循环）。运行期间议题处于 in_progress，结束后停在 in_review。返回 run id，或引擎拒绝的原因。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_run",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const issue = await resolveIssue(args.issue, workspaceId)
    const by = await resolveIssueActor(ctx)

    const { listIssueRunOptions, startIssueRun, IssueRunRefusedError } =
      await import("@/lib/issues/run/registry")
    const options = await listIssueRunOptions(issue.id)
    const accepting = options.filter((option) => option.verdict.ok)

    let adapterId = args.adapterId
    if (adapterId) {
      const chosen = options.find((option) => option.adapter.id === adapterId)
      if (!chosen) {
        return {
          status: "refused",
          reason: "adapter-missing",
          available: options.map((option) => option.adapter.id),
        }
      }
      if (!chosen.verdict.ok) {
        return { status: "refused", reason: chosen.verdict.reason, detail: chosen.verdict.detail }
      }
    } else {
      const first = accepting[0]
      if (!first) {
        // Every adapter refused. Report each reason: the tracker-level ones
        // (run already active, issue finished) are the same for all of them,
        // and the model should say which rather than guess.
        return {
          status: "refused",
          reason: "no-engine-accepts",
          verdicts: options.map((option) => ({
            adapterId: option.adapter.id,
            reason: option.verdict.ok ? null : option.verdict.reason,
          })),
        }
      }
      adapterId = first.adapter.id
    }

    try {
      const run = await startIssueRun({
        issueId: issue.id,
        adapterId,
        by,
        origin: ctx.imBinding ? "im" : "interactive",
      })
      return {
        status: "started",
        runId: run.id,
        adapterId: run.adapterId,
        kind: run.kind,
        identifier: issue.identifier,
      }
    } catch (error) {
      if (error instanceof IssueRunRefusedError) {
        return { status: "refused", reason: error.reason, detail: error.detail ?? null }
      }
      throw error
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_run_${Date.now().toString(36)}`,
      title: "Run issue",
      summary: `Hand ${args.issue} to an execution engine.`,
      details: args.adapterId ? [{ label: "Engine", value: args.adapterId }] : [],
    }),
}

registerBuiltInSkill(skill)
