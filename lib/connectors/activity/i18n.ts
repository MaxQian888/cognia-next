/**
 * Locale-driven string bag for the live-activity card body (Feature A/B).
 *
 * The connector outbound path runs in the renderer but is NOT React, so it
 * can't call `useTranslations()`. Following the established connector
 * precedent (`lib/notifications/im-deliver.ts`, `runtime.ts` reply strings),
 * the activity-card body strings live here as a self-contained static map
 * (en + zh-CN) rather than going through next-intl. The locale is read from
 * `AppSettings.locale` at the runtime call site.
 *
 * The inbox override-form's `liveActivity` toggle (a `.tsx` surface) DOES use
 * next-intl via the i18n JSON — those keys live in
 * `inbox.conversationOverride.fields.liveActivity` in the message files.
 */
export interface ActivityI18n {
  /** Title verb while the turn is running, e.g. "Working". */
  working: string
  /** Title verb on success, e.g. "Done". */
  done: string
  /** Title verb on failure, e.g. "Failed". */
  failed: string
  /** "{count}" → tool count label fragment. */
  tools: (count: number) => string
  /** "{count}" → edit count label fragment. */
  edits: (count: number) => string
  /** "{seconds}" → elapsed seconds suffix. */
  elapsed: (seconds: number) => string
  /** "{name}" → current-tool line. */
  currentTool: (name: string) => string
  /** "{path} {added} {removed}" → terminal edit summary. */
  fileEdited: (path: string, added: number, removed: number) => string
  /** "{path} {added}" → terminal write/create summary. */
  fileCreated: (path: string, added: number) => string
  /** "{count}" → truncated-diff line count note. */
  diffTruncated: (count: number) => string
  /** Hint that a Collapsible can be expanded. */
  diffExpandHint: string
  /** Body note when a file was too large to diff. */
  diffSkipped: string
  /**
   * Compact one-line progress note for APPEND mode (adapters without `edit()`).
   * `{tools}` tool count, `{seconds}` elapsed, optional `{current}` tool name.
   */
  appendLine: (tools: number, seconds: number, current: string | null) => string
  /** Terminal one-line note for APPEND mode. `{status}` done|failed, `{seconds}` elapsed. */
  appendFinal: (status: "done" | "failed", seconds: number) => string
  /** Localized durable run status. */
  runStatus: (status: import("@/types/execution/run").ExecutionRunStatus) => string
  /** Localized durable run kind. */
  runKind: (kind: import("@/types/execution/run").ExecutionRunKind) => string
  /** Localized deterministic activity label; custom safe labels pass through. */
  activityLabel: (activity: import("@/types/execution/run").RunActivitySnapshot) => string
  /** Trustworthy completed/total progress. */
  progress: (completed: number, total: number, percent: number) => string
  /** Dynamic-run completed activity count. */
  completedActivities: (count: number) => string
  /** Rolling-window omission notice. */
  omittedActivities: (count: number) => string
  /** Durable inbound turns waiting behind the active run. */
  queuedTurns: (count: number) => string
  /** Empty public activity state. */
  noPublicActivity: string
  /** Heading of the milestone block, with completed/total. */
  milestones: (completed: number, total: number) => string
  /** One milestone line: status icon is supplied by the caller. */
  milestoneStatus: (status: import("@/types/execution/run").RunStepStatus) => string
  /** "{count}" → milestones beyond the rendered window. */
  moreMilestones: (count: number) => string
  /** Terminal note naming where a run stopped. */
  stoppedBecause: (reason: string) => string
  /** Terminal note for milestones that never ran. */
  notReached: (count: number) => string
}

const EN: ActivityI18n = {
  working: "Working",
  done: "Done",
  failed: "Failed",
  tools: (c) => `${c} tool${c === 1 ? "" : "s"}`,
  edits: (c) => `${c} edit${c === 1 ? "" : "s"}`,
  elapsed: (s) => `${s}s`,
  currentTool: (n) => `Current: ${n}`,
  fileEdited: (p, a, r) => `${p} (+${a} −${r})`,
  fileCreated: (p, a) => `${p} (+${a})`,
  diffTruncated: (c) => `${c} more lines truncated`,
  diffExpandHint: "Tap to expand",
  diffSkipped: "File too large to diff — summary only",
  appendLine: (tools, seconds, current) =>
    `⏳ Working — ${tools} tool${tools === 1 ? "" : "s"}, ${seconds}s` +
    (current ? ` · ${current}` : ""),
  appendFinal: (status, seconds) =>
    status === "done" ? `✅ Done (${seconds}s)` : `❌ Failed (${seconds}s)`,
  runStatus: (status) =>
    ({
      queued: "Queued",
      running: "Working",
      waiting: "Waiting for review",
      paused: "Paused",
      recovery_required: "Recovery required",
      completed: "Task completed",
      failed: "Task failed",
      cancelled: "Task cancelled",
    })[status],
  runKind: (kind) =>
    ({
      "agent-turn": "Agent",
      workflow: "Workflow",
      plan: "Plan",
      goal: "Goal",
      team: "Team",
      scheduled: "Scheduled run",
    })[kind],
  activityLabel: (activity) =>
    ({
      "Run started": "Run started",
      "Waiting for review": "Waiting for review",
      "Run paused": "Run paused",
      "Run resumed": "Run resumed",
      "Recovery required": "Recovery required",
      "Presentation degraded": "Presentation degraded",
      "Run completed": "Run completed",
      "Run failed": "Run failed",
      "Run cancelled": "Run cancelled",
      "Approval required": "Approval required",
      Approval: "Approval required",
      "Artifact created": "Artifact created",
      Step: "Step",
      Tool: "Tool",
      Activity: "Activity",
    })[activity.label] ?? activity.label,
  progress: (completed, total, percent) => `${completed}/${total} (${percent}%)`,
  completedActivities: (count) => `${count} completed`,
  omittedActivities: (count) => `… ${count} earlier activities hidden`,
  queuedTurns: (count) => `${count} queued turn${count === 1 ? "" : "s"}`,
  noPublicActivity: "No public activity yet",
  milestones: (completed, total) => `**Plan** — ${completed}/${total}`,
  milestoneStatus: (status) =>
    ({
      pending: "Pending",
      in_progress: "In progress",
      completed: "Completed",
      failed: "Failed",
      blocked: "Blocked",
      skipped: "Skipped",
    })[status] ?? status,
  moreMilestones: (count) => `… and ${count} more`,
  stoppedBecause: (reason) => `Stopped: ${reason}`,
  notReached: (count) => `${count} milestone${count === 1 ? "" : "s"} not reached`,
}

const ZH: ActivityI18n = {
  working: "处理中",
  done: "完成",
  failed: "失败",
  tools: (c) => `${c} 工具`,
  edits: (c) => `${c} 处编辑`,
  elapsed: (s) => `${s}s`,
  currentTool: (n) => `当前：${n}`,
  fileEdited: (p, a, r) => `${p}（+${a} −${r}）`,
  fileCreated: (p, a) => `${p}（+${a}）`,
  diffTruncated: (c) => `另有 ${c} 行已截断`,
  diffExpandHint: "点击展开",
  diffSkipped: "文件过大，无法生成差异——仅显示摘要",
  appendLine: (tools, seconds, current) =>
    `⏳ 处理中 —— ${tools} 工具，${seconds}s` + (current ? ` · ${current}` : ""),
  appendFinal: (status, seconds) =>
    status === "done" ? `✅ 完成（${seconds}s）` : `❌ 失败（${seconds}s）`,
  runStatus: (status) =>
    ({
      queued: "等待执行",
      running: "处理中",
      waiting: "等待审核",
      paused: "已暂停",
      recovery_required: "需要恢复",
      completed: "任务已完成",
      failed: "任务失败",
      cancelled: "任务已取消",
    })[status],
  runKind: (kind) =>
    ({
      "agent-turn": "智能体",
      workflow: "工作流",
      plan: "计划",
      goal: "目标",
      team: "团队",
      scheduled: "定时任务",
    })[kind],
  activityLabel: (activity) =>
    ({
      "Run started": "开始执行",
      "Waiting for review": "等待审核",
      "Run paused": "执行已暂停",
      "Run resumed": "继续执行",
      "Recovery required": "需要恢复",
      "Presentation degraded": "展示已降级",
      "Run completed": "任务已完成",
      "Run failed": "任务失败",
      "Run cancelled": "任务已取消",
      "Approval required": "需要审批",
      Approval: "需要审批",
      "Artifact created": "已创建产物",
      Step: "步骤",
      Tool: "工具",
      Activity: "活动",
    })[activity.label] ?? activity.label,
  progress: (completed, total, percent) => `${completed}/${total}（${percent}%）`,
  completedActivities: (count) => `已完成 ${count} 项`,
  omittedActivities: (count) => `… 已隐藏更早的 ${count} 项活动`,
  queuedTurns: (count) => `另有 ${count} 条消息排队`,
  noPublicActivity: "暂无可公开的执行活动",
  milestones: (completed, total) => `**计划** — ${completed}/${total}`,
  milestoneStatus: (status) =>
    ({
      pending: "待办",
      in_progress: "进行中",
      completed: "已完成",
      failed: "失败",
      blocked: "受阻",
      skipped: "已跳过",
    })[status] ?? status,
  moreMilestones: (count) => `…还有 ${count} 项`,
  stoppedBecause: (reason) => `已停止：${reason}`,
  notReached: (count) => `${count} 项里程碑未执行`,
}

const MAPS: Record<string, ActivityI18n> = {
  en: EN,
  "en-US": EN,
  "zh-CN": ZH,
  zh: ZH,
  "zh-Hans": ZH,
}

/**
 * Resolve the activity-card string bag for a locale. Falls back to English
 * for any unrecognized locale so an unknown setting never produces empty
 * card text.
 */
export function resolveActivityI18n(locale: string | undefined | null): ActivityI18n {
  if (locale && MAPS[locale]) return MAPS[locale]
  return EN
}
