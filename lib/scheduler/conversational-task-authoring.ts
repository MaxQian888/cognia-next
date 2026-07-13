/**
 * Conversational task drafts — typed helpers for `/schedule`-style flows that
 * turn a free-form intent ("remind me every morning to triage PRs") into a
 * `CreateScheduledTaskInput` ready for the scheduler store.
 *
 * Each helper emits the new typed payload shape consumed by
 * `lib/scheduler/executors/index.ts`. `prompt` is the canonical user-turn
 * field across chat / agent / skill / external-agent. The legacy field names
 * (`message`, `agentTask`) used by older drafts are accepted by the
 * normaliser below and rewritten in place — the executor also has a
 * back-compat fallback so existing IndexedDB rows keep working until the
 * scheduler runs them once.
 */

import type {
  AgentTaskPayload,
  ChatLikeTaskPayload,
  CreateScheduledTaskInput,
  ExternalAgentTaskPayload,
  ScheduledTaskPayload,
  ScheduledTaskType,
  SkillTaskPayload,
  TaskExecutionConfig,
  TaskNotificationConfig,
  TaskTrigger,
} from "@/types/scheduler"
import type { SendOptions, BuiltinToolsConfig } from "@cognia/agent-config-types"
import type { AcpPermissionMode } from "@/types/agent/external-agent"
import { SchedulerError } from "./errors"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

const DEFAULT_CONVERSATIONAL_CRON = "0 9 * * *"
const DEFAULT_AGENT_MAX_STEPS = 10

// =============================================================================
// Defaults / draft request shapes
// =============================================================================

interface ConversationalSchedulerDefaults {
  timezone?: string
  provider?: string
  model?: string
  autoReply?: boolean
  maxSteps?: number
  planningEnabled?: boolean
}

/**
 * The set of `ChatLikeTaskPayload` knobs we let the conversational helpers
 * pre-fill. Plain shape-aliases — the executor is the single source of truth
 * for what these fields mean.
 */
interface ChatLikePayloadOverrides {
  sessionId?: string
  sessionTitle?: string
  teamId?: string
  agentModeId?: string | null
  permissionMode?: SendOptions["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  additionalDirectories?: string[]
  builtinTools?: Partial<BuiltinToolsConfig>
  appendSystemPrompt?: string
  maxTurns?: number
  effort?: SendOptions["effort"]
  disabledSkillIds?: string[]
}

interface ScheduledChatTaskDraftRequest extends ChatLikePayloadOverrides {
  name?: string
  description?: string
  /** The user-turn content. `message` is also accepted for back-compat. */
  message?: string
  prompt?: string
  autoReply?: boolean
  provider?: string
  model?: string
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

interface ScheduledAgentTaskDraftRequest extends ChatLikePayloadOverrides {
  name?: string
  description?: string
  /** The user-turn content. `agentTask` is also accepted for back-compat. */
  prompt?: string
  agentTask?: string
  /**
   * Character (a.k.a. agent persona) that drives the reply. Optional at
   * draft time so intent-classifier flows can produce a partial draft for
   * the user to complete in the form. The executor enforces presence at
   * run time — it returns an `agent task requires characterId` error
   * otherwise.
   */
  characterId?: string
  provider?: string
  model?: string
  /** Mapped to `payload.maxTurns`. */
  maxSteps?: number
  /** Carried along verbatim as `payload.planningEnabled` for downstream consumers. */
  planningEnabled?: boolean
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

interface ScheduledSkillTaskDraftRequest extends ChatLikePayloadOverrides {
  name?: string
  description?: string
  prompt: string
  /** Required. Skill enabled for the run, in addition to character's set. */
  skillId: string
  provider?: string
  model?: string
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

interface ScheduledExternalAgentTaskDraftRequest {
  name?: string
  description?: string
  prompt: string
  /** Required. ExternalAgentConfig.id of the configured ACP agent. */
  agentId: string
  permissionMode?: AcpPermissionMode
  cwd?: string
  timeoutMs?: number
  trigger?: Partial<TaskTrigger>
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  tags?: string[]
}

export interface ConversationalTaskDraft {
  summary: string
  input: CreateScheduledTaskInput
}

// =============================================================================
// Helpers
// =============================================================================

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

/**
 * Pull the `ChatLikePayloadOverrides` block out of a draft request and copy
 * it onto a typed payload, dropping `undefined` keys so the IndexedDB row
 * stays compact.
 */
function applyChatLikeOverrides<T extends ChatLikeTaskPayload>(
  base: T,
  src: ChatLikePayloadOverrides
): T {
  const out: T = { ...base }
  if (src.sessionId !== undefined) out.sessionId = src.sessionId
  if (src.sessionTitle !== undefined) out.sessionTitle = src.sessionTitle
  if (src.teamId !== undefined) out.teamId = src.teamId
  if (src.agentModeId !== undefined) out.agentModeId = src.agentModeId
  if (src.permissionMode !== undefined) out.permissionMode = src.permissionMode
  if (src.allowedTools !== undefined) out.allowedTools = src.allowedTools
  if (src.disallowedTools !== undefined) out.disallowedTools = src.disallowedTools
  if (src.mcpServerIds !== undefined) out.mcpServerIds = src.mcpServerIds
  if (src.additionalDirectories !== undefined) out.additionalDirectories = src.additionalDirectories
  if (src.builtinTools !== undefined) out.builtinTools = src.builtinTools
  if (src.appendSystemPrompt !== undefined) out.appendSystemPrompt = src.appendSystemPrompt
  if (src.maxTurns !== undefined) out.maxTurns = src.maxTurns
  if (src.effort !== undefined) out.effort = src.effort
  if (src.disabledSkillIds !== undefined) out.disabledSkillIds = src.disabledSkillIds
  return out
}

// =============================================================================
// Drafts
// =============================================================================

export function createScheduledChatTaskDraft(
  request: ScheduledChatTaskDraftRequest,
  defaults: ConversationalSchedulerDefaults = {}
): ConversationalTaskDraft {
  const promptText =
    normalizeOptionalString(request.prompt) ?? normalizeOptionalString(request.message)
  if (!promptText) {
    throw SchedulerError.invalidTrigger("Scheduled chat tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "chat",
    })
  }
  const trigger = buildTrigger(request.trigger, defaults.timezone)
  const provider = normalizeOptionalString(request.provider) || defaults.provider
  const model = normalizeOptionalString(request.model) || defaults.model
  const autoReply = request.autoReply ?? defaults.autoReply ?? true

  const basePayload: ChatLikeTaskPayload = applyChatLikeOverrides(
    {
      prompt: promptText,
      // autoReply / provider are not part of ChatLikeTaskPayload, but we keep
      // them in the open-ended record half so downstream UI / telemetry can
      // still see them.
      autoReply,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    } as ChatLikeTaskPayload,
    request
  )

  return {
    summary: `定时聊天任务：${truncateSummary(promptText)}`,
    input: {
      name: buildDefaultName("Scheduled Chat", promptText, request.name),
      description: normalizeOptionalString(request.description),
      type: "chat",
      trigger,
      payload: basePayload,
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
  const promptText =
    normalizeOptionalString(request.prompt) ?? normalizeOptionalString(request.agentTask)
  if (!promptText) {
    throw SchedulerError.invalidTrigger("Scheduled agent tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "agent",
    })
  }
  const characterId = normalizeOptionalString(request.characterId)
  const trigger = buildTrigger(request.trigger, defaults.timezone)
  const provider = normalizeOptionalString(request.provider) || defaults.provider
  const model = normalizeOptionalString(request.model) || defaults.model
  const maxSteps = request.maxSteps ?? defaults.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
  const planningEnabled = request.planningEnabled ?? defaults.planningEnabled ?? true

  const basePayload: AgentTaskPayload = applyChatLikeOverrides(
    {
      prompt: promptText,
      // characterId is required at execution time but optional at draft time —
      // intent classifiers don't always know which agent the user means.
      ...(characterId ? { characterId } : {}),
      maxTurns: request.maxTurns ?? maxSteps,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      planningEnabled,
    } as AgentTaskPayload,
    request
  )

  return {
    summary: `定时代理任务：${truncateSummary(promptText)}`,
    input: {
      name: buildDefaultName("Scheduled Agent", promptText, request.name),
      description: normalizeOptionalString(request.description),
      type: "agent",
      trigger,
      payload: basePayload,
      config: request.config,
      notification: request.notification,
      tags: request.tags,
    },
  }
}

export function createScheduledSkillTaskDraft(
  request: ScheduledSkillTaskDraftRequest,
  defaults: ConversationalSchedulerDefaults = {}
): ConversationalTaskDraft {
  const promptText = normalizeOptionalString(request.prompt)
  if (!promptText) {
    throw SchedulerError.invalidTrigger("Scheduled skill tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "skill",
    })
  }
  const skillId = normalizeOptionalString(request.skillId)
  if (!skillId) {
    throw SchedulerError.invalidTrigger("Scheduled skill tasks require a non-empty skillId", {
      field: "skillId",
      taskType: "skill",
    })
  }
  const trigger = buildTrigger(request.trigger, defaults.timezone)
  const provider = normalizeOptionalString(request.provider) || defaults.provider
  const model = normalizeOptionalString(request.model) || defaults.model

  const basePayload: SkillTaskPayload = applyChatLikeOverrides(
    {
      prompt: promptText,
      skillId,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    } as SkillTaskPayload,
    request
  )

  return {
    summary: `定时技能任务：${truncateSummary(promptText)}`,
    input: {
      name: buildDefaultName("Scheduled Skill", promptText, request.name),
      description: normalizeOptionalString(request.description),
      type: "skill",
      trigger,
      payload: basePayload,
      config: request.config,
      notification: request.notification,
      tags: request.tags,
    },
  }
}

export function createScheduledExternalAgentTaskDraft(
  request: ScheduledExternalAgentTaskDraftRequest,
  defaults: ConversationalSchedulerDefaults = {}
): ConversationalTaskDraft {
  const promptText = normalizeOptionalString(request.prompt)
  if (!promptText) {
    throw SchedulerError.invalidTrigger(
      "Scheduled external-agent tasks require a non-empty prompt",
      { field: "prompt", taskType: "external-agent" }
    )
  }
  const agentId = normalizeOptionalString(request.agentId)
  if (!agentId) {
    throw SchedulerError.invalidTrigger(
      "Scheduled external-agent tasks require a non-empty agentId",
      { field: "agentId", taskType: "external-agent" }
    )
  }
  const trigger = buildTrigger(request.trigger, defaults.timezone)

  const basePayload: ExternalAgentTaskPayload = {
    prompt: promptText,
    agentId,
    ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(typeof request.timeoutMs === "number" && request.timeoutMs > 0
      ? { timeoutMs: request.timeoutMs }
      : {}),
  }

  return {
    summary: `定时外部代理任务：${truncateSummary(promptText)}`,
    input: {
      name: buildDefaultName("Scheduled External Agent", promptText, request.name),
      description: normalizeOptionalString(request.description),
      type: "external-agent",
      trigger,
      payload: basePayload,
      config: request.config,
      notification: request.notification,
      tags: request.tags,
    },
  }
}

// =============================================================================
// Normaliser — accepts new (`prompt`) and legacy (`message` / `agentTask`)
// payload shapes and rewrites them to the new canonical form.
// =============================================================================

const legacyWarnedTaskKeys = new Set<string>()

function warnLegacyOnce(taskKey: string, legacyField: "message" | "agentTask") {
  if (legacyWarnedTaskKeys.has(taskKey)) return
  legacyWarnedTaskKeys.add(taskKey)
  log.warn(
    `[deprecated] conversational task draft uses \`${legacyField}\` instead of \`prompt\`. Auto-migrating; please update authoring code.`,
    { taskKey }
  )
}

function normalizeChatPayload(
  payload: Record<string, unknown>,
  warnKey: string
): ScheduledTaskPayload {
  let prompt = normalizeOptionalString(payload.prompt)
  if (!prompt) {
    const legacy = normalizeOptionalString(payload.message)
    if (legacy) {
      prompt = legacy
      warnLegacyOnce(warnKey, "message")
    }
  }
  if (!prompt) {
    throw SchedulerError.invalidTrigger("Scheduled chat tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "chat",
    })
  }

  const next: Record<string, unknown> = { ...payload, prompt }
  delete next.message

  const sessionId = normalizeOptionalString(payload.sessionId)
  const provider = normalizeOptionalString(payload.provider)
  const model = normalizeOptionalString(payload.model)

  return {
    ...next,
    autoReply: typeof payload.autoReply === "boolean" ? payload.autoReply : true,
    ...(sessionId ? { sessionId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  } as ScheduledTaskPayload
}

function normalizeAgentPayload(
  payload: Record<string, unknown>,
  warnKey: string
): ScheduledTaskPayload {
  let prompt = normalizeOptionalString(payload.prompt)
  if (!prompt) {
    const legacy = normalizeOptionalString(payload.agentTask)
    if (legacy) {
      prompt = legacy
      warnLegacyOnce(warnKey, "agentTask")
    }
  }
  if (!prompt) {
    throw SchedulerError.invalidTrigger("Scheduled agent tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "agent",
    })
  }

  // Hoist legacy `payload.config.{provider,model,maxSteps,planningEnabled}` to
  // the top-level shape consumed by the executor.
  const rawConfig =
    payload.config && typeof payload.config === "object" && !Array.isArray(payload.config)
      ? { ...(payload.config as Record<string, unknown>) }
      : undefined

  const provider =
    normalizeOptionalString(payload.provider) ??
    (rawConfig ? normalizeOptionalString(rawConfig.provider) : undefined)
  const model =
    normalizeOptionalString(payload.model) ??
    (rawConfig ? normalizeOptionalString(rawConfig.model) : undefined)
  const planningEnabled =
    typeof payload.planningEnabled === "boolean"
      ? payload.planningEnabled
      : rawConfig && typeof rawConfig.planningEnabled === "boolean"
        ? rawConfig.planningEnabled
        : true
  const maxTurns =
    typeof payload.maxTurns === "number" && payload.maxTurns > 0
      ? Math.floor(payload.maxTurns)
      : rawConfig && typeof rawConfig.maxSteps === "number" && rawConfig.maxSteps > 0
        ? Math.floor(rawConfig.maxSteps)
        : DEFAULT_AGENT_MAX_STEPS

  const characterId = normalizeOptionalString(payload.characterId)

  const next: Record<string, unknown> = { ...payload, prompt }
  delete next.agentTask
  delete next.config

  return {
    ...next,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(characterId ? { characterId } : {}),
    maxTurns,
    planningEnabled,
  } as ScheduledTaskPayload
}

function normalizeSkillPayload(payload: Record<string, unknown>): ScheduledTaskPayload {
  const prompt = normalizeOptionalString(payload.prompt)
  if (!prompt) {
    throw SchedulerError.invalidTrigger("Scheduled skill tasks require a non-empty prompt", {
      field: "prompt",
      taskType: "skill",
    })
  }
  const skillId = normalizeOptionalString(payload.skillId)
  if (!skillId) {
    throw SchedulerError.invalidTrigger("Scheduled skill tasks require a non-empty skillId", {
      field: "skillId",
      taskType: "skill",
    })
  }
  return { ...payload, prompt, skillId } as ScheduledTaskPayload
}

function normalizeExternalAgentPayload(payload: Record<string, unknown>): ScheduledTaskPayload {
  const prompt = normalizeOptionalString(payload.prompt)
  if (!prompt) {
    throw SchedulerError.invalidTrigger(
      "Scheduled external-agent tasks require a non-empty prompt",
      { field: "prompt", taskType: "external-agent" }
    )
  }
  const agentId = normalizeOptionalString(payload.agentId)
  if (!agentId) {
    throw SchedulerError.invalidTrigger(
      "Scheduled external-agent tasks require a non-empty agentId",
      { field: "agentId", taskType: "external-agent" }
    )
  }
  return { ...payload, prompt, agentId } as ScheduledTaskPayload
}

export function normalizeConversationalTaskPayload(
  taskType: ScheduledTaskType,
  payload?: ScheduledTaskPayload,
  warnKey: string = `${taskType}:anon`
): ScheduledTaskPayload | undefined {
  if (payload == null) {
    if (taskType === "chat") {
      throw SchedulerError.invalidTrigger("Scheduled chat tasks require a non-empty prompt", {
        field: "prompt",
        taskType,
      })
    }
    if (taskType === "agent") {
      throw SchedulerError.invalidTrigger("Scheduled agent tasks require a non-empty prompt", {
        field: "prompt",
        taskType,
      })
    }
    if (taskType === "skill") {
      throw SchedulerError.invalidTrigger("Scheduled skill tasks require a non-empty prompt", {
        field: "prompt",
        taskType,
      })
    }
    if (taskType === "external-agent") {
      throw SchedulerError.invalidTrigger(
        "Scheduled external-agent tasks require a non-empty prompt",
        { field: "prompt", taskType }
      )
    }
    return payload
  }

  if (typeof payload !== "object") {
    throw SchedulerError.invalidTrigger(`Scheduled ${taskType} task payload must be an object`, {
      taskType,
    })
  }

  if (taskType === "chat") return normalizeChatPayload(payload as Record<string, unknown>, warnKey)
  if (taskType === "agent")
    return normalizeAgentPayload(payload as Record<string, unknown>, warnKey)
  if (taskType === "skill") return normalizeSkillPayload(payload as Record<string, unknown>)
  if (taskType === "external-agent")
    return normalizeExternalAgentPayload(payload as Record<string, unknown>)

  return payload
}
