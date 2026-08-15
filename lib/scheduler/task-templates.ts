/**
 * Task templates surfaced in the gallery dialog.
 *
 * The gallery curates a small set of templates over the chat / agent / skill /
 * script executors. Each template returns a fully-formed
 * `CreateScheduledTaskInput` whose `payload` shape matches the executor it
 * targets (see `lib/scheduler/executors/index.ts`); `sync` / `ai-generation`
 * are deprecated and must never appear here.
 */

import type {
  CreateScheduledTaskInput,
  ScheduledTaskType,
  TaskTriggerType,
} from "@/types/scheduler"

export type TaskTemplateCategory = "productivity" | "ai" | "monitoring" | "automation"

export interface TaskTemplate {
  id: string
  name: string
  nameZh: string
  description: string
  descriptionZh: string
  category: TaskTemplateCategory
  icon: string
  taskType: ScheduledTaskType
  triggerType: TaskTriggerType
  getInput: () => CreateScheduledTaskInput
}

const localTimezone = (): string =>
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"

export const TASK_TEMPLATES: TaskTemplate[] = [
  // ===== AI Category =====
  {
    id: "daily-briefing",
    name: "Daily Briefing",
    nameZh: "每日简报",
    description: "Generate a daily summary at 8 AM",
    descriptionZh: "每天早上 8 点生成日常简报",
    category: "ai",
    icon: "☀️",
    taskType: "chat",
    triggerType: "cron",
    getInput: () => ({
      name: "Daily Briefing",
      description: "AI-generated morning summary",
      type: "chat",
      trigger: { type: "cron", cronExpression: "0 8 * * *", timezone: localTimezone() },
      payload: {
        prompt:
          "Give me a concise briefing for today: top priorities, calendar highlights, and any urgent items.",
        sessionTitle: "Daily Briefing",
      },
      tags: ["daily", "ai"],
    }),
  },
  {
    id: "weekly-review",
    name: "Weekly Review",
    nameZh: "每周回顾",
    description: "Friday afternoon review of the week",
    descriptionZh: "每周五下午回顾本周工作",
    category: "ai",
    icon: "📊",
    taskType: "chat",
    triggerType: "cron",
    getInput: () => ({
      name: "Weekly Review",
      description: "AI-generated weekly summary every Friday",
      type: "chat",
      trigger: { type: "cron", cronExpression: "0 17 * * 5", timezone: localTimezone() },
      payload: {
        prompt: "Summarize this week: what shipped, what slipped, what to carry into next week.",
        sessionTitle: "Weekly Review",
      },
      tags: ["weekly", "ai"],
    }),
  },

  // ===== Productivity =====
  {
    id: "standup-reminder",
    name: "Standup Reminder",
    nameZh: "站会提醒",
    description: "Weekday 9:30 AM standup nudge",
    descriptionZh: "工作日早 9:30 站会提醒",
    category: "productivity",
    icon: "🕘",
    taskType: "chat",
    triggerType: "cron",
    getInput: () => ({
      name: "Standup Reminder",
      description: "Daily standup at 9:30 AM (weekdays only)",
      type: "chat",
      trigger: { type: "cron", cronExpression: "30 9 * * 1-5", timezone: localTimezone() },
      payload: {
        prompt: "Remind me what I committed to yesterday and what I should report at standup.",
        sessionTitle: "Standup Notes",
      },
      tags: ["standup", "productivity"],
      notification: { onStart: false, onComplete: true, onError: true, channels: ["toast"] },
    }),
  },

  // ===== Automation =====
  {
    id: "cleanup-temp",
    name: "Clean Temp Files",
    nameZh: "清理临时文件",
    description: "Delete temp files weekly",
    descriptionZh: "每周清理一次临时文件",
    category: "automation",
    icon: "🧹",
    taskType: "script",
    triggerType: "cron",
    getInput: () => ({
      name: "Clean Temp Files",
      description: "Weekly Sunday 3 AM cleanup",
      type: "script",
      trigger: { type: "cron", cronExpression: "0 3 * * 0", timezone: localTimezone() },
      payload: {
        language: "bash",
        code: 'find /tmp -type f -atime +7 -delete\necho "Temp cleanup complete"',
        timeout_secs: 60,
      },
      tags: ["cleanup", "automation"],
    }),
  },

  // ===== Monitoring =====
  {
    id: "health-check",
    name: "Hourly Health Check",
    nameZh: "每小时健康检查",
    description: "Ping a URL every hour",
    descriptionZh: "每小时检查一次服务可用性",
    category: "monitoring",
    icon: "🩺",
    taskType: "script",
    triggerType: "interval",
    getInput: () => ({
      name: "Hourly Health Check",
      description: "Curl a URL every hour and surface failures",
      type: "script",
      trigger: { type: "interval", intervalMs: 60 * 60 * 1000 },
      payload: {
        language: "bash",
        code: "curl --max-time 10 -fsS https://example.com >/dev/null && echo OK || echo FAIL",
        timeout_secs: 30,
      },
      tags: ["monitoring"],
      notification: {
        onStart: false,
        onComplete: false,
        onError: true,
        channels: ["desktop", "toast"],
      },
    }),
  },
]

export const TEMPLATE_CATEGORIES: Array<{
  id: TaskTemplateCategory
  name: string
  nameZh: string
  description: string
  descriptionZh: string
  icon: string
}> = [
  {
    id: "ai",
    name: "AI Tasks",
    nameZh: "AI 任务",
    description: "Briefings, summaries, and other AI-driven flows",
    descriptionZh: "简报、总结等 AI 驱动任务",
    icon: "🤖",
  },
  {
    id: "productivity",
    name: "Productivity",
    nameZh: "生产力",
    description: "Reminders and recurring chat prompts",
    descriptionZh: "提醒与周期对话",
    icon: "⚡",
  },
  {
    id: "automation",
    name: "Automation",
    nameZh: "自动化",
    description: "Shell scripts and recurring jobs",
    descriptionZh: "Shell 脚本与周期任务",
    icon: "⚙️",
  },
  {
    id: "monitoring",
    name: "Monitoring",
    nameZh: "监控",
    description: "Health checks and watchers",
    descriptionZh: "可用性检查与监控",
    icon: "📡",
  },
]

export function getTemplatesByCategory(category: TaskTemplateCategory): TaskTemplate[] {
  return TASK_TEMPLATES.filter((tpl) => tpl.category === category)
}

export function getTemplateById(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((tpl) => tpl.id === id)
}
