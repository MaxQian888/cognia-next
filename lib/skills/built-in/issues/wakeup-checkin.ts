/**
 * `issue.wakeup_checkin`: a periodic wakeup's run reports that it looked and
 * there was nothing to deliver.
 *
 * Settles the run with the note and hands the issue back to the column it was
 * in, instead of the usual advance to review (`checkInIssueRun`). Accepted
 * only from the run itself: the calling session must be one the run is
 * executing in, the run must have been started by THIS wakeup, and the
 * wakeup must be a cron/interval rule. Anything else would let one
 * conversation quietly close another's run.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"

const schema = z.object({
  wakeupId: z.string().min(1).describe("The wakeup id from the [WAKEUP …] line of your brief."),
  note: z
    .string()
    .min(1)
    .max(500)
    .describe("One line: what you checked and why nothing is needed."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.wakeup_checkin",
  family: "issue",
  label: { en: "Check in on issue wakeup", "zh-CN": "议题唤醒签到" },
  description: {
    en: "Only for a run started by a periodic issue wakeup: settle the run with a short note when there is nothing to deliver. The issue stays where it was instead of moving to review.",
    "zh-CN":
      "仅用于由周期性议题唤醒启动的运行：在没有需要交付的内容时，用一句说明结束本次运行。议题保持原位，不会进入待审阅。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_wakeup_checkin",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const [
      { getIssueWakeup },
      { isPeriodicWakeup, readWakeupPayload },
      { listIssueRuns },
      registry,
    ] = await Promise.all([
      import("@/lib/issues/wakeups/service"),
      import("@/lib/issues/wakeups/model"),
      import("@/lib/db/issue-runs"),
      import("@/lib/issues/run/registry"),
    ])
    const task = await getIssueWakeup(args.wakeupId)
    if (!task) return { status: "refused", reason: "not-a-wakeup", wakeupId: args.wakeupId }
    if (!isPeriodicWakeup(task)) {
      return { status: "refused", reason: "not-periodic", wakeupId: args.wakeupId }
    }
    const payload = readWakeupPayload(task.payload)!
    const run = (await listIssueRuns({ issueId: payload.issueId, activeOnly: true })).find(
      (candidate) => candidate.wakeup?.taskId === task.id
    )
    if (!run) return { status: "refused", reason: "no-active-run", wakeupId: args.wakeupId }
    const sessions = await registry.issueRunSessionIds(run)
    if (!ctx.sessionId || !sessions.includes(ctx.sessionId)) {
      return { status: "refused", reason: "not-this-run", wakeupId: args.wakeupId }
    }
    const result = await registry.checkInIssueRun(run.id, args.note)
    if (result.status === "refused") {
      return { status: "refused", reason: result.reason, wakeupId: args.wakeupId }
    }
    return { status: "checked-in", runId: run.id, wakeupId: args.wakeupId }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_wakeup_checkin_${Date.now().toString(36)}`,
      title: "Check in on issue wakeup",
      summary: "End this periodic run with a note and leave the issue where it is.",
      details: [
        { label: "Wakeup", value: args.wakeupId },
        { label: "Note", value: args.note.slice(0, 200) },
      ],
    }),
}

registerBuiltInSkill(skill)
