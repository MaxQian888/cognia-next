/**
 * IM scheduler control commands.
 *
 * `/tasks` lists only tasks originating from the current conversation.
 * `/schedule` creates or removes the same scoped task type. Authorization is
 * enforced by the caller (`dispatch.ts`); this module owns cadence validation,
 * quotas, provenance, rendering, and scheduler calls so the future agent tools
 * can reuse the exact same policy.
 */

import { parseInterval, MIN_INTERVAL_MS } from "@/lib/loop/interval"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import {
  a2uiComponent,
  buildA2UIMessageSegment,
} from "@/lib/connectors/a2ui-bridge/surface-builder"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import type { CreateScheduledTaskInput, ScheduledTask, TaskExecution } from "@/types/scheduler"

export const MAX_SCHEDULES_PER_CONVERSATION = 8
export const MAX_SCHEDULES_PER_USER = 16

export interface ScheduleCommandScheduler {
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  getAllTasks(): Promise<ScheduledTask[]>
  deleteTask(taskId: string): Promise<boolean>
  runTaskNow?(taskId: string): Promise<TaskExecution | null>
}

interface ScheduleProvenance {
  source: "im"
  adapterId: string
  conversationKey: string
  senderId: string
}

interface ScheduleCommandInput {
  name: "tasks" | "schedule"
  arg: string
  event: NormalizedInboundEvent
  characterId?: string
  reply: (
    content: string | MessageSegment[],
    kind: "applied" | "denied" | "unknown",
    extraFields?: Record<string, unknown>
  ) => Promise<void>
  scheduler?: ScheduleCommandScheduler
}

type ParsedScheduleAction =
  | { kind: "create"; trigger: CreateScheduledTaskInput["trigger"]; prompt: string }
  | { kind: "off"; selector: string }
  | { kind: "invalid" }

function provenanceOf(task: ScheduledTask): ScheduleProvenance | null {
  const raw = (task.payload as Record<string, unknown> | undefined)?.scheduleProvenance
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (
    value.source !== "im" ||
    typeof value.adapterId !== "string" ||
    typeof value.conversationKey !== "string" ||
    typeof value.senderId !== "string"
  ) {
    return null
  }
  return value as unknown as ScheduleProvenance
}

export function listVisibleScheduleTasks(
  tasks: readonly ScheduledTask[],
  conversationKey: string
): ScheduledTask[] {
  return tasks
    .filter((task) => provenanceOf(task)?.conversationKey === conversationKey)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

function rawIntervalMs(token: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/i.exec(token)
  if (!match) return null
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
  return Number(match[1]) * unitMs[match[2].toLowerCase() as keyof typeof unitMs]
}

export function parseScheduleAction(arg: string): ParsedScheduleAction {
  const trimmed = arg.trim()
  if (!trimmed) return { kind: "invalid" }

  const off = /^off\s+(\S+)$/i.exec(trimmed)
  if (off) return { kind: "off", selector: off[1] }

  if (/^cron(?:\s|$)/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/)
    if (parts.length < 7) return { kind: "invalid" }
    const cronExpression = parts.slice(1, 6).join(" ")
    const prompt = parts.slice(6).join(" ").trim()
    if (!prompt) return { kind: "invalid" }
    return { kind: "create", trigger: { type: "cron", cronExpression }, prompt }
  }

  const separator = trimmed.search(/\s/)
  if (separator < 0) return { kind: "invalid" }
  const token = trimmed.slice(0, separator)
  const prompt = trimmed.slice(separator).trim()
  const requestedMs = rawIntervalMs(token)
  const intervalMs = parseInterval(token)
  if (!prompt || requestedMs === null || requestedMs < MIN_INTERVAL_MS || intervalMs === null) {
    return { kind: "invalid" }
  }
  return { kind: "create", trigger: { type: "interval", intervalMs }, prompt }
}

function resolveTaskSelector(
  tasks: readonly ScheduledTask[],
  selector: string
): ScheduledTask | null {
  const index = Number(selector)
  if (Number.isInteger(index) && index >= 1 && index <= tasks.length) return tasks[index - 1]
  const exact = tasks.find((task) => task.id === selector)
  if (exact) return exact
  const prefixed = tasks.filter((task) => task.id.startsWith(selector))
  return prefixed.length === 1 ? prefixed[0] : null
}

function taskListSegments(tasks: readonly ScheduledTask[]): MessageSegment[] {
  const plainText =
    tasks.length === 0
      ? "本会话暂无定时任务 / No scheduled tasks for this conversation."
      : [
          "本会话定时任务 / Scheduled tasks:",
          ...tasks.map(
            (task, index) =>
              `${index + 1}. ${task.name} · ${task.status} · ${task.nextRunAt?.toISOString() ?? "—"} · ${task.id.slice(0, 8)}`
          ),
        ].join("\n")

  const children = tasks.map((task, index) => `task-${index}`)
  const components = [
    a2uiComponent.card("root", {
      title: "本会话定时任务 / Scheduled tasks",
      description:
        tasks.length === 0
          ? "暂无任务 / No tasks"
          : `${tasks.length} 个任务 / ${tasks.length} task(s)`,
      children,
    }),
    ...tasks.map((task, index) =>
      a2uiComponent.text(
        `task-${index}`,
        `${index + 1}. ${task.name}\n${task.status} · ${task.nextRunAt?.toISOString() ?? "—"} · ${task.id.slice(0, 8)}`,
        { variant: "body" }
      )
    ),
  ]

  return [
    buildA2UIMessageSegment(`schedule-list-${crypto.randomUUID()}`, {
      components,
      rootId: "root",
      title: "Scheduled tasks",
      widget: { fallbackText: plainText },
    }),
  ]
}

function scheduleUsage(): string {
  return [
    "用法 / Usage:",
    "• /schedule 5m <提示词 prompt>",
    "• /schedule cron <5-field cron> <提示词 prompt>",
    "• /schedule off <序号或任务 id / number or task id>",
    "最小间隔为 60 秒 / Minimum interval is 60 seconds.",
  ].join("\n")
}

function scheduleName(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim()
  return `IM: ${compact.length <= 60 ? compact : `${compact.slice(0, 59)}…`}`
}

export async function handleScheduleCommand(input: ScheduleCommandInput): Promise<void> {
  const scheduler = input.scheduler ?? getTaskScheduler()
  const allTasks = await scheduler.getAllTasks()
  const visible = listVisibleScheduleTasks(allTasks, input.event.conversationKey)

  if (input.name === "tasks") {
    await input.reply(taskListSegments(visible), "applied", { taskCount: visible.length })
    return
  }

  const action = parseScheduleAction(input.arg)
  if (action.kind === "invalid") {
    await input.reply(scheduleUsage(), "denied", { reason: "invalid_schedule_syntax" })
    return
  }

  if (action.kind === "off") {
    const target = resolveTaskSelector(visible, action.selector)
    if (!target) {
      await input.reply(
        "未找到本会话中的对应任务 / No matching task in this conversation.",
        "denied",
        { reason: "schedule_not_visible", selector: action.selector }
      )
      return
    }
    await scheduler.deleteTask(target.id)
    await input.reply(`已关闭定时任务 / Scheduled task removed: ${target.name}`, "applied", {
      taskId: target.id,
    })
    return
  }

  const senderId = input.event.sender.remoteUserId
  const userTaskCount = allTasks.filter((task) => provenanceOf(task)?.senderId === senderId).length
  if (visible.length >= MAX_SCHEDULES_PER_CONVERSATION) {
    await input.reply(
      `本会话最多可创建 ${MAX_SCHEDULES_PER_CONVERSATION} 个定时任务 / This conversation is limited to ${MAX_SCHEDULES_PER_CONVERSATION} scheduled tasks.`,
      "denied",
      { reason: "schedule_conversation_quota" }
    )
    return
  }
  if (userTaskCount >= MAX_SCHEDULES_PER_USER) {
    await input.reply(
      `每位用户最多可创建 ${MAX_SCHEDULES_PER_USER} 个 IM 定时任务 / Each user is limited to ${MAX_SCHEDULES_PER_USER} IM scheduled tasks.`,
      "denied",
      { reason: "schedule_user_quota" }
    )
    return
  }

  const provenance: ScheduleProvenance = {
    source: "im",
    adapterId: input.event.adapterId,
    conversationKey: input.event.conversationKey,
    senderId,
  }
  const task = await scheduler.createTask({
    name: scheduleName(action.prompt),
    description: `Created from IM conversation ${input.event.conversationKey}`,
    type: "connection:scheduled:digest",
    trigger: action.trigger,
    payload: {
      adapterId: input.event.adapterId,
      conversationKey: input.event.conversationKey,
      characterId: input.characterId ?? "",
      prompt: action.prompt,
      scheduleProvenance: provenance,
    },
    notification: {
      onStart: false,
      onComplete: false,
      onError: true,
      channels: ["im"],
      imTarget: { conversationKey: input.event.conversationKey },
    },
    tags: ["connector", "im-schedule"],
  })

  await input.reply(
    [
      `已创建定时任务 / Scheduled task created: ${task.name}`,
      `下次运行 / Next run: ${task.nextRunAt?.toISOString() ?? "—"}`,
      `ID: ${task.id}`,
    ].join("\n"),
    "applied",
    { taskId: task.id }
  )
}
