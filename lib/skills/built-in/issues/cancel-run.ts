/**
 * `issue.cancel_run`: stop an in-flight run and give the issue back.
 *
 * The counterpart to `issue.run`. Cancelling returns the issue to `todo`
 * rather than parking it at `in_review`, which is what `settleIssueRunAndIssue`
 * already does for the Run dialog's cancel button. This tool adds no second
 * cancel path, it just reaches the existing one.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveWorkspaceId } from "./_core"

const schema = z.object({
  runId: z.string().min(1).describe("Run id, as returned by issue_run or listed by issue_get."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.cancel_run",
  family: "issue",
  label: { en: "Cancel issue run", "zh-CN": "取消议题运行" },
  description: {
    en: "Cancel an in-flight issue run. The engine is asked to stop and the issue returns to the todo column. Use issue_get to find the run id.",
    "zh-CN":
      "取消进行中的议题运行：通知引擎停止，并把议题退回 todo 列。可用 issue_get 查到 run id。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_cancel_run",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const { getIssueRun } = await import("@/lib/db/issue-runs")
    const run = await getIssueRun(args.runId)
    if (!run) return { status: "not-found", runId: args.runId }
    // Runs carry the workspace so this needs no join, and without the check a
    // run id from another workspace would cancel work this session cannot see.
    if (run.projectId !== workspaceId) {
      return { status: "refused", reason: "other-workspace", runId: args.runId }
    }
    if (run.status !== "queued" && run.status !== "running") {
      return { status: "already-settled", runId: args.runId, runStatus: run.status }
    }

    const { cancelIssueRun } = await import("@/lib/issues/run/registry")
    const settled = await cancelIssueRun(args.runId)
    return { status: "cancelled", runId: args.runId, runStatus: settled?.status ?? "cancelled" }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_cancel_run_${Date.now().toString(36)}`,
      title: "Cancel issue run",
      summary: "Stop the in-flight run and return the issue to todo.",
      details: [{ label: "Run", value: args.runId }],
    }),
}

registerBuiltInSkill(skill)
