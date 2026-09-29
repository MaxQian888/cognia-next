/**
 * `issue.wakeup_create`: subscribe to something on an issue and get a run
 * when it happens.
 *
 * The agent-facing door onto `lib/issues/wakeups/service.ts`. A wakeup is a
 * scheduler task, so the user's scheduler policy decides whether agents may
 * write one at all, how many they may own and whether each needs a person's
 * confirmation (`authorizeTaskWrite`, asked in preflight and again at write).
 * `issue-wakeup` is deliberately NOT one of `schedule.create`'s types: its
 * payload names an issue and a match the generic payload schema cannot check,
 * and one write path per kind of task is how the gates stay in one place.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { ISSUE_STAGE_MAX, ISSUE_STATUSES } from "@/types/issues"
import { ISSUE_WAKEUP_EVENT_KINDS, type IssueWakeupTriggerSpec } from "@/lib/issues/wakeups/model"
import { issueRefSchema, resolveIssue, resolveIssueActor, resolveWorkspaceId } from "./_core"

export const wakeupTriggerSchema = z
  .discriminatedUnion("on", [
    z.object({
      on: z.literal("event"),
      kinds: z
        .array(z.enum(ISSUE_WAKEUP_EVENT_KINDS))
        .max(10)
        .optional()
        .describe(
          "Trail kinds to wake on, e.g. ['commented']. child_status_changed / child_stage_changed fire when a sub-issue changes status / stage. Omit for any activity."
        ),
      actorKinds: z
        .array(z.enum(["human", "agent", "team"]))
        .optional()
        .describe("Only when caused by these. ['human'] means 'only when a person acts'."),
      toStatuses: z
        .array(z.enum(ISSUE_STATUSES))
        .optional()
        .describe("For status changes: only when the issue moves to one of these."),
    }),
    z
      .object({
        on: z.literal("children-done"),
        stage: z
          .number()
          .int()
          .min(1)
          .max(ISSUE_STAGE_MAX)
          .optional()
          .describe(
            "Only staged sub-issues up to this stage count; fires once that stage and every earlier one are finished. Omit to wait for every sub-issue."
          ),
      })
      .describe("When every sub-issue (or every sub-issue up to a stage) is done or canceled."),
    z
      .object({ on: z.literal("issue-finished"), issue: issueRefSchema })
      .describe("When another issue in this workspace is done or canceled."),
    z
      .object({ on: z.literal("pr-merged") })
      .describe(
        "When a pull request linked to the issue merges. Needs the issue's project bound to its GitHub repository in import mode; refused otherwise."
      ),
    z.object({
      on: z.literal("cron"),
      cronExpression: z.string().min(1).describe("5-field cron, e.g. '0 9 * * 1-5'."),
      timezone: z.string().optional().describe("IANA timezone; defaults to the user's."),
    }),
    z.object({
      on: z.literal("interval"),
      intervalMs: z
        .number()
        .int()
        .min(60_000)
        .describe("Milliseconds between checks, at least one minute."),
    }),
    z.object({ on: z.literal("at"), runAt: z.string().describe("ISO-8601 instant, once.") }),
  ])
  .describe("What wakes the rule. Exactly one shape.")

const schema = z.object({
  issue: issueRefSchema.describe("The issue the rule belongs to, and where its runs happen."),
  instruction: z
    .string()
    .min(1)
    .max(2000)
    .describe("What the woken agent should do. It also receives what happened."),
  trigger: wakeupTriggerSchema,
  adapterId: z
    .string()
    .optional()
    .describe("Run engine to dispatch to. Omit to take the first engine that accepts the issue."),
  once: z
    .boolean()
    .optional()
    .describe(
      "Stop after the first delivery. Defaults to true for children-done / issue-finished / pr-merged."
    ),
  maxFires: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Fire budget; the rule expires once spent. Defaults to 20."),
  expiresAt: z.string().optional().describe("ISO-8601 instant after which the rule expires."),
})

type Args = z.infer<typeof schema>

async function toSpec(args: Args, ctx: Pick<BuiltInSkillContext, "sessionId">) {
  const workspaceId = await resolveWorkspaceId(ctx)
  const issue = await resolveIssue(args.issue, workspaceId)
  const t = args.trigger
  let trigger: IssueWakeupTriggerSpec
  switch (t.on) {
    case "issue-finished":
      trigger = {
        on: "issue-finished",
        targetIssueId: (await resolveIssue(t.issue, workspaceId)).id,
      }
      break
    case "at": {
      const runAt = new Date(t.runAt)
      if (Number.isNaN(runAt.getTime()))
        throw new Error(`runAt is not an ISO-8601 instant: ${t.runAt}`)
      trigger = { on: "at", runAt }
      break
    }
    default:
      trigger = t
  }
  const expiresAt = args.expiresAt ? new Date(args.expiresAt) : undefined
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error(`expiresAt is not an ISO-8601 instant: ${args.expiresAt}`)
  }
  return {
    issue,
    spec: {
      issueId: issue.id,
      instruction: args.instruction,
      trigger,
      ...(args.adapterId ? { adapterId: args.adapterId } : {}),
      ...(args.once !== undefined ? { once: args.once } : {}),
      ...(args.maxFires !== undefined ? { maxFires: args.maxFires } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  }
}

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.wakeup_create",
  family: "issue",
  label: { en: "Add issue wakeup", "zh-CN": "新建议题唤醒" },
  description: {
    en: "Subscribe to an issue: when the trigger happens (a comment, a status change, every sub-issue or sub-issue stage finishing, another issue finishing, a linked pull request merging, or a timer), an agent run starts on the issue with the instruction and what happened. If a run is already active the input joins it. Rules that loop between agents or fire too often pause themselves.",
    "zh-CN":
      "订阅一个议题：当触发条件发生（评论、状态变化、所有子议题或某个子议题阶段完成、另一个议题完成、关联的拉取请求合并或定时），会在该议题上启动一次 Agent 运行，并带上指令和发生的事。若已有运行进行中，输入会并入该运行。在 Agent 之间循环或触发过于频繁的规则会自动暂停。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_wakeup_create",
  inputSchema: schema,
  preflight: async (args, ctx) => {
    const { spec } = await toSpec(args, ctx)
    const { validateIssueWakeupSpec } = await import("@/lib/issues/wakeups/service")
    await validateIssueWakeupSpec(spec)
    const { resolveTaskWrite } = await import("../scheduler/_core")
    await resolveTaskWrite({
      taskType: "issue-wakeup",
      sessionId: ctx.sessionId,
      humanConfirmed: ctx.humanConfirmed,
      operation: "create",
    })
  },
  execute: async (args, ctx) => {
    const { issue, spec } = await toSpec(args, ctx)
    const author = await resolveIssueActor(ctx)
    const { createIssueWakeup } = await import("@/lib/issues/wakeups/service")
    const { summariseWakeup } = await import("@/lib/issues/wakeups/model")
    const task = await createIssueWakeup({
      ...spec,
      author,
      source: "agent",
      createdBy: { kind: "agent", sessionId: ctx.sessionId },
      sessionId: ctx.sessionId,
      ...(ctx.humanConfirmed ? { humanConfirmed: true } : {}),
    })
    return {
      status: "created",
      identifier: issue.identifier,
      wakeup: summariseWakeup(task),
      hint: "The user can pause or delete it from the issue's Wakeups section.",
    }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_wakeup_create_${Date.now().toString(36)}`,
      title: "Add issue wakeup",
      summary: `Wake an agent on ${args.issue} (${args.trigger.on}).`,
      details: [
        { label: "Instruction", value: args.instruction.slice(0, 200) },
        ...(args.once ? [{ label: "Runs", value: "once" }] : []),
        ...(args.maxFires ? [{ label: "Fire budget", value: String(args.maxFires) }] : []),
      ],
    }),
}

registerBuiltInSkill(skill)
