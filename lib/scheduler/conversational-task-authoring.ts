import type {
  CreateScheduledTaskInput,
  ScheduledTaskPayload,
  ScheduledTaskType,
  TaskExecutionConfig,
  TaskNotificationConfig,
  TaskTrigger,
} from "@/types/scheduler"
import { SchedulerError } from "./errors"

const DEFAULT_CONVERSATIONAL_CRON = "0 9 * * *"
const DEFAULT_AGENT_MAX_STEPS = 10

interface ConversationalSchedulerDefaults {
  timezone?: string
  provider?: string
  model?: string
  autoReply?: boolean
  maxSteps?: number
  planningEnabled?: boolean
}

interface ScheduledChatTaskDraftRequest {
  name?: string
  description?: string
  message: string
  sessionId?: string
  autoReply?: boolean
  provider?: string
  model?: string
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

interface ScheduledAgentTaskDraftRequest {
  name?: string
  description?: string
  agentTask: string
  provider?: string
  model?: string
  maxSteps?: number
  planningEnabled?: boolean
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

export interface ConversationalTaskDraft {
  summary: string
  input: CreateScheduledTaskInput
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function buildTrigger(
  trigger: Partial<TaskTrigger> | undefined,
  timezone: string | undefined
): TaskTrigger {
  const triggerType = trigger?.type || "cron"

  if (triggerType === "interval") {
    return {
      type: "interval",
      intervalMs: trigger?.intervalMs,
      dependsOn: trigger?.dependsOn,
    }
  }

  if (triggerType === "once") {
    return {
      type: "once",
      runAt: trigger?.runAt,
      dependsOn: trigger?.dependsOn,
    }
  }

  if (triggerType === "event") {
    return {
      type: "event",
      eventType: trigger?.eventType,
      eventSource: trigger?.eventSource,
      dependsOn: trigger?.dependsOn,
    }
  }

  return {
    type: "cron",
    cronExpression: normalizeOptionalString(trigger?.cronExpression) || DEFAULT_CONVERSATIONAL_CRON,
    timezone: normalizeOptionalString(trigger?.timezone) || timezone,
    dependsOn: trigger?.dependsOn,
  }
}

function truncateSummary(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}...` : text
}

function buildDefaultName(prefix: string, value: string, explicitName?: string): string {
  return normalizeOptionalString(explicitName) || `${prefix}: ${truncateSummary(value)}`
}

export function createScheduledChatTaskDraft(
  request: ScheduledChatTaskDraftRequest,
  defaults: ConversationalSchedulerDefaults = {}
): ConversationalTaskDraft {
  const message = request.message.trim()
  const trigger = buildTrigger(request.trigger, defaults.timezone)
  const provider = normalizeOptionalString(request.provider) || defaults.provider
  const model = normalizeOptionalString(request.model) || defaults.model
  const autoReply = request.autoReply ?? defaults.autoReply ?? true

  return {
    summary: `定时聊天任务：${truncateSummary(message)}`,
    input: {
      name: buildDefaultName("Scheduled Chat", message, request.name),
      description: normalizeOptionalString(request.description),
      type: "chat",
      trigger,
      payload: {
        message,
        sessionId: normalizeOptionalString(request.sessionId),
        autoReply,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
      config: request.config,
      notification: request.notification,
      tags: request.tags,
    },
  }
}

export function createScheduledAgentTaskDraft(
  request: ScheduledAgentTaskDraftRequest,
  defaults: ConversationalSchedulerDefaults = {}
): ConversationalTaskDraft {
  const agentTask = request.agentTask.trim()
  const trigger = buildTrigger(request.trigger, defaults.timezone)
  const provider = normalizeOptionalString(request.provider) || defaults.provider
  const model = normalizeOptionalString(request.model) || defaults.model
  const maxSteps = request.maxSteps ?? defaults.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
  const planningEnabled = request.planningEnabled ?? defaults.planningEnabled ?? true

  return {
    summary: `定时代理任务：${truncateSummary(agentTask)}`,
    input: {
      name: buildDefaultName("Scheduled Agent", agentTask, request.name),
      description: normalizeOptionalString(request.description),
      type: "agent",
      trigger,
      payload: {
        agentTask,
        config: {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          maxSteps,
          planningEnabled,
        },
      },
      config: request.config,
      notification: request.notification,
      tags: request.tags,
    },
  }
}

function normalizeChatPayload(payload: Record<string, unknown>): ScheduledTaskPayload {
  const message = normalizeOptionalString(payload.message)
  if (!message) {
    throw SchedulerError.invalidTrigger(
      "Scheduled chat tasks require a non-empty message payload",
      {
        field: "message",
        taskType: "chat",
      }
    )
  }

  const sessionId = normalizeOptionalString(payload.sessionId)
  const provider = normalizeOptionalString(payload.provider)
  const model = normalizeOptionalString(payload.model)

  return {
    ...payload,
    message,
    autoReply: typeof payload.autoReply === "boolean" ? payload.autoReply : true,
    ...(sessionId ? { sessionId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }
}

function normalizeAgentPayload(payload: Record<string, unknown>): ScheduledTaskPayload {
  const agentTask = normalizeOptionalString(payload.agentTask)
  if (!agentTask) {
    throw SchedulerError.invalidTrigger(
      "Scheduled agent tasks require a non-empty agent task prompt",
      {
        field: "agentTask",
        taskType: "agent",
      }
    )
  }

  const rawConfig =
    payload.config && typeof payload.config === "object"
      ? { ...(payload.config as Record<string, unknown>) }
      : {}

  const provider = normalizeOptionalString(rawConfig.provider)
  const model = normalizeOptionalString(rawConfig.model)
  const planningEnabled =
    typeof rawConfig.planningEnabled === "boolean" ? rawConfig.planningEnabled : true
  const maxSteps =
    typeof rawConfig.maxSteps === "number" && rawConfig.maxSteps > 0
      ? Math.floor(rawConfig.maxSteps)
      : DEFAULT_AGENT_MAX_STEPS

  return {
    ...payload,
    agentTask,
    config: {
      ...rawConfig,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      planningEnabled,
      maxSteps,
    },
  }
}

export function normalizeConversationalTaskPayload(
  taskType: ScheduledTaskType,
  payload?: ScheduledTaskPayload
): ScheduledTaskPayload | undefined {
  if (payload == null) {
    if (taskType === "chat") {
      throw SchedulerError.invalidTrigger(
        "Scheduled chat tasks require a non-empty message payload",
        {
          field: "message",
          taskType,
        }
      )
    }
    if (taskType === "agent") {
      throw SchedulerError.invalidTrigger(
        "Scheduled agent tasks require a non-empty agent task prompt",
        {
          field: "agentTask",
          taskType,
        }
      )
    }
    return payload
  }

  if (typeof payload !== "object") {
    throw SchedulerError.invalidTrigger(`Scheduled ${taskType} task payload must be an object`, {
      taskType,
    })
  }

  if (taskType === "chat") {
    return normalizeChatPayload(payload as Record<string, unknown>)
  }

  if (taskType === "agent") {
    return normalizeAgentPayload(payload as Record<string, unknown>)
  }

  return payload
}
