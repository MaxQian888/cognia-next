/**
 * Shared draft / payload shapes for the structured task-payload editors.
 *
 * The form keeps its working state in `ChatLikeDraft` (one shape for chat,
 * agent, and skill tasks — distinct fields are validated per task type) and
 * `ExternalAgentDraft`. Drafts are converted to the typed payload shapes
 * defined in `@/types/scheduler` on submit.
 */

import type {
  AgentTaskPayload,
  AgentTeamTaskPayload,
  BackgroundCommandTaskPayload,
  ChatLikeTaskPayload,
  ExternalAgentTaskPayload,
  GoalTaskPayload,
  ImPushTaskPayload,
  PlanTaskPayload,
  ScheduledTaskType,
  SkillTaskPayload,
  WorkflowTaskPayload,
} from "@/types/scheduler"
import type { BuiltinToolsConfig, SendOptions } from "@cognia/agent-config-types"
import type { AcpPermissionMode } from "@/types/agent/external-agent"

/**
 * MCP picker mode — "default" lets `resolveSendOptions` pick the subset
 * (character → team → all enabled), "custom" uses the explicit
 * `mcpServerIds` array. Distinguishing this matters because an empty array
 * has the meaning "no MCP at all" — we don't want that to be the same as
 * "use the character's default".
 */
export type McpPickerMode = "default" | "custom"

export interface ChatLikeDraft {
  prompt: string

  // Per-type required fields (validated at submit)
  characterId?: string
  skillId?: string

  // Session continuity
  sessionId?: string
  sessionTitle?: string
  teamId?: string

  // Mode + model
  agentModeId?: string | null
  model?: string

  // Permission + tool
  permissionMode?: SendOptions["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpMode: McpPickerMode
  mcpServerIds?: string[]
  additionalDirectories?: string[]
  builtinTools?: Partial<BuiltinToolsConfig>

  // Misc
  appendSystemPrompt?: string
  maxTurns?: number
  effort?: SendOptions["effort"]
  disabledSkillIds?: string[]
}

export interface ExternalAgentDraft {
  prompt: string
  agentId: string
  permissionMode?: AcpPermissionMode
  cwd?: string
  timeoutMs?: number
}

export const EMPTY_CHAT_LIKE_DRAFT: ChatLikeDraft = {
  prompt: "",
  mcpMode: "default",
}

export const EMPTY_EXTERNAL_AGENT_DRAFT: ExternalAgentDraft = {
  prompt: "",
  agentId: "",
}

/** Draft for `agent-team` tasks — runs a whole AgentTeam to terminal. */
export interface AgentTeamDraft {
  teamId: string
  ultracode: boolean
}

/** Draft for `goal` tasks — creates + drives a self-driving goal headlessly. */
export interface GoalDraft {
  objective: string
  characterId?: string
  maxTurns?: number
  maxTokens?: number
  timeoutMinutes?: number
}

/**
 * Draft for `background-command` tasks.
 *
 * Three fields, and it had no structured editor at all: the create form fell
 * through to a raw JSON textarea, so scheduling a command meant knowing the
 * payload key names by heart and getting the JSON right by hand.
 */
export interface BackgroundCommandDraft {
  command: string
  cwd: string
  label?: string
}

/** Draft for `plan` tasks — executes an existing AgentPlan. */
export interface PlanDraft {
  planId: string
  replanOnFailure: boolean
}

/**
 * Draft for `workflow` tasks — runs a published visual workflow. `inputsJson`
 * is kept as text so partially-typed JSON survives re-renders; it is parsed
 * on submit.
 */
export interface WorkflowDraft {
  workflowId: string
  environment: string
  inputsJson: string
  triggerId: string
  idempotencyKey: string
}

/** Draft for `im-push` tasks — text (or raw segments JSON) into a bound conversation. */
export interface ImPushDraft {
  conversationKey: string
  text: string
  /** Optional raw `MessageSegment[]` JSON; when non-empty it wins over `text`. */
  segmentsJson: string
  idempotencyKey: string
}

export const EMPTY_AGENT_TEAM_DRAFT: AgentTeamDraft = { teamId: "", ultracode: false }
export const EMPTY_GOAL_DRAFT: GoalDraft = { objective: "" }
export const EMPTY_BACKGROUND_COMMAND_DRAFT: BackgroundCommandDraft = {
  command: "",
  cwd: "",
}
export const EMPTY_PLAN_DRAFT: PlanDraft = { planId: "", replanOnFailure: false }
export const EMPTY_WORKFLOW_DRAFT: WorkflowDraft = {
  workflowId: "",
  environment: "",
  inputsJson: "",
  triggerId: "",
  idempotencyKey: "",
}
export const EMPTY_IM_PUSH_DRAFT: ImPushDraft = {
  conversationKey: "",
  text: "",
  segmentsJson: "",
  idempotencyKey: "",
}

/**
 * Convert an existing JSON-shaped payload back into a `ChatLikeDraft` so an
 * edit-in-place flow doesn't lose user input when the form mounts.
 *
 * Field name reconciliation: if the payload uses the legacy `message` /
 * `agentTask` keys we lift them to `prompt` (mirrors the executor's lazy
 * migration). Unknown / non-string values are dropped.
 */
export function payloadToChatLikeDraft(taskType: ScheduledTaskType, raw: unknown): ChatLikeDraft {
  const draft: ChatLikeDraft = { ...EMPTY_CHAT_LIKE_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>

  if (typeof p.prompt === "string") draft.prompt = p.prompt
  else if (typeof p.message === "string") draft.prompt = p.message
  else if (typeof p.agentTask === "string") draft.prompt = p.agentTask

  if (typeof p.characterId === "string") draft.characterId = p.characterId
  if (typeof p.skillId === "string") draft.skillId = p.skillId
  if (typeof p.sessionId === "string") draft.sessionId = p.sessionId
  if (typeof p.sessionTitle === "string") draft.sessionTitle = p.sessionTitle
  if (typeof p.teamId === "string") draft.teamId = p.teamId
  if (typeof p.model === "string") draft.model = p.model
  if (p.agentModeId === null) draft.agentModeId = null
  else if (typeof p.agentModeId === "string") draft.agentModeId = p.agentModeId

  if (typeof p.permissionMode === "string")
    draft.permissionMode = p.permissionMode as SendOptions["permissionMode"]

  if (Array.isArray(p.allowedTools)) {
    draft.allowedTools = p.allowedTools.filter((s): s is string => typeof s === "string")
  }
  if (Array.isArray(p.disallowedTools)) {
    draft.disallowedTools = p.disallowedTools.filter((s): s is string => typeof s === "string")
  }
  if (Array.isArray(p.mcpServerIds)) {
    draft.mcpServerIds = p.mcpServerIds.filter((s): s is string => typeof s === "string")
    draft.mcpMode = "custom"
  }
  if (Array.isArray(p.additionalDirectories)) {
    draft.additionalDirectories = p.additionalDirectories.filter(
      (s): s is string => typeof s === "string"
    )
  }
  if (Array.isArray(p.disabledSkillIds)) {
    draft.disabledSkillIds = p.disabledSkillIds.filter((s): s is string => typeof s === "string")
  }

  if (p.builtinTools && typeof p.builtinTools === "object" && !Array.isArray(p.builtinTools)) {
    const bt = p.builtinTools as Record<string, unknown>
    const partial: Partial<BuiltinToolsConfig> = {}
    if (typeof bt.fileExtras === "boolean") partial.fileExtras = bt.fileExtras
    if (typeof bt.git === "boolean") partial.git = bt.git
    if (typeof bt.process === "boolean") partial.process = bt.process
    if (typeof bt.environment === "boolean") partial.environment = bt.environment
    if (typeof bt.shellAdvanced === "boolean") partial.shellAdvanced = bt.shellAdvanced
    if (Object.keys(partial).length > 0) draft.builtinTools = partial
  }

  if (typeof p.appendSystemPrompt === "string") draft.appendSystemPrompt = p.appendSystemPrompt
  if (typeof p.maxTurns === "number" && p.maxTurns > 0) draft.maxTurns = Math.floor(p.maxTurns)
  if (typeof p.effort === "string") draft.effort = p.effort as SendOptions["effort"]

  // Acknowledge the task-type discriminator without forcing characterId / skillId
  // when the payload is partial. Validation happens at submit.
  void taskType
  return draft
}

export function payloadToExternalAgentDraft(raw: unknown): ExternalAgentDraft {
  const draft: ExternalAgentDraft = { ...EMPTY_EXTERNAL_AGENT_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.prompt === "string") draft.prompt = p.prompt
  if (typeof p.agentId === "string") draft.agentId = p.agentId
  if (typeof p.permissionMode === "string")
    draft.permissionMode = p.permissionMode as AcpPermissionMode
  if (typeof p.cwd === "string") draft.cwd = p.cwd
  if (typeof p.timeoutMs === "number" && p.timeoutMs > 0) draft.timeoutMs = Math.floor(p.timeoutMs)
  return draft
}

/**
 * Serialize a draft to its typed payload shape. Drops empty strings / empty
 * arrays so the resulting JSON stays compact and round-trips cleanly. Throws
 * a `DraftValidationError` when required per-type fields are missing — the
 * UI surfaces the per-field messages.
 */
export class DraftValidationError extends Error {
  constructor(public errors: Record<string, string>) {
    super("Draft validation failed")
    this.name = "DraftValidationError"
  }
}

function trimOrUndef(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const t = value.trim()
  return t.length > 0 ? t : undefined
}

export function chatLikeDraftToPayload(
  taskType: ScheduledTaskType,
  draft: ChatLikeDraft
): ChatLikeTaskPayload | AgentTaskPayload | SkillTaskPayload {
  const errors: Record<string, string> = {}
  const prompt = trimOrUndef(draft.prompt)
  if (!prompt) errors.prompt = "promptRequired"

  let characterId: string | undefined
  if (taskType === "agent") {
    characterId = trimOrUndef(draft.characterId)
    if (!characterId) errors.characterId = "characterIdRequired"
  } else if (draft.characterId) {
    characterId = trimOrUndef(draft.characterId)
  }

  let skillId: string | undefined
  if (taskType === "skill") {
    skillId = trimOrUndef(draft.skillId)
    if (!skillId) errors.skillId = "skillIdRequired"
  }

  if (Object.keys(errors).length > 0) throw new DraftValidationError(errors)

  const out: ChatLikeTaskPayload = { prompt: prompt! }

  if (draft.sessionId) out.sessionId = trimOrUndef(draft.sessionId)
  if (draft.sessionTitle) out.sessionTitle = trimOrUndef(draft.sessionTitle)
  if (draft.teamId) out.teamId = trimOrUndef(draft.teamId)

  if (draft.model) out.model = trimOrUndef(draft.model)

  if (draft.agentModeId === null) out.agentModeId = null
  else if (typeof draft.agentModeId === "string" && draft.agentModeId.trim().length > 0)
    out.agentModeId = draft.agentModeId

  if (draft.permissionMode) out.permissionMode = draft.permissionMode

  if (draft.allowedTools && draft.allowedTools.length > 0) {
    out.allowedTools = [...draft.allowedTools]
  }
  if (draft.disallowedTools && draft.disallowedTools.length > 0) {
    out.disallowedTools = [...draft.disallowedTools]
  }
  if (draft.mcpMode === "custom") {
    out.mcpServerIds = draft.mcpServerIds ? [...draft.mcpServerIds] : []
  }
  if (draft.additionalDirectories && draft.additionalDirectories.length > 0) {
    out.additionalDirectories = [...draft.additionalDirectories]
  }
  if (draft.disabledSkillIds && draft.disabledSkillIds.length > 0) {
    out.disabledSkillIds = [...draft.disabledSkillIds]
  }
  if (draft.builtinTools && Object.keys(draft.builtinTools).length > 0) {
    out.builtinTools = { ...draft.builtinTools }
  }
  if (draft.appendSystemPrompt && draft.appendSystemPrompt.trim().length > 0) {
    out.appendSystemPrompt = draft.appendSystemPrompt.trim()
  }
  if (typeof draft.maxTurns === "number" && draft.maxTurns > 0) {
    out.maxTurns = Math.floor(draft.maxTurns)
  }
  if (draft.effort) out.effort = draft.effort

  if (taskType === "agent") {
    return { ...out, characterId: characterId! } as AgentTaskPayload
  }
  if (taskType === "skill") {
    const result: SkillTaskPayload = { ...out, skillId: skillId! }
    if (characterId) result.characterId = characterId
    return result
  }
  if (characterId) out.characterId = characterId
  return out
}

export function externalAgentDraftToPayload(draft: ExternalAgentDraft): ExternalAgentTaskPayload {
  const errors: Record<string, string> = {}
  const prompt = trimOrUndef(draft.prompt)
  if (!prompt) errors.prompt = "promptRequired"
  const agentId = trimOrUndef(draft.agentId)
  if (!agentId) errors.agentId = "agentIdRequired"
  if (Object.keys(errors).length > 0) throw new DraftValidationError(errors)

  const out: ExternalAgentTaskPayload = { prompt: prompt!, agentId: agentId! }
  if (draft.permissionMode) out.permissionMode = draft.permissionMode
  if (draft.cwd) {
    const cwd = trimOrUndef(draft.cwd)
    if (cwd) out.cwd = cwd
  }
  if (typeof draft.timeoutMs === "number" && draft.timeoutMs > 0) {
    out.timeoutMs = Math.floor(draft.timeoutMs)
  }
  return out
}

// ── Built-in multi-agent drafts (agent-team / goal / plan) ──────────────────

export function payloadToAgentTeamDraft(raw: unknown): AgentTeamDraft {
  const draft: AgentTeamDraft = { ...EMPTY_AGENT_TEAM_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.teamId === "string") draft.teamId = p.teamId
  if (typeof p.ultracode === "boolean") draft.ultracode = p.ultracode
  return draft
}

export function payloadToBackgroundCommandDraft(raw: unknown): BackgroundCommandDraft {
  const draft: BackgroundCommandDraft = { ...EMPTY_BACKGROUND_COMMAND_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.command === "string") draft.command = p.command
  if (typeof p.cwd === "string") draft.cwd = p.cwd
  if (typeof p.label === "string") draft.label = p.label
  return draft
}

export function payloadToGoalDraft(raw: unknown): GoalDraft {
  const draft: GoalDraft = { ...EMPTY_GOAL_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.objective === "string") draft.objective = p.objective
  if (typeof p.characterId === "string") draft.characterId = p.characterId
  const cfg = p.config && typeof p.config === "object" ? (p.config as Record<string, unknown>) : {}
  if (typeof cfg.maxTurns === "number" && cfg.maxTurns > 0)
    draft.maxTurns = Math.floor(cfg.maxTurns)
  if (typeof cfg.maxTokens === "number" && cfg.maxTokens > 0)
    draft.maxTokens = Math.floor(cfg.maxTokens)
  if (typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0)
    draft.timeoutMinutes = Math.round(cfg.timeoutMs / 60_000)
  return draft
}

export function payloadToPlanDraft(raw: unknown): PlanDraft {
  const draft: PlanDraft = { ...EMPTY_PLAN_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.planId === "string") draft.planId = p.planId
  if (typeof p.replanOnFailure === "boolean") draft.replanOnFailure = p.replanOnFailure
  return draft
}

export function agentTeamDraftToPayload(draft: AgentTeamDraft): AgentTeamTaskPayload {
  const teamId = trimOrUndef(draft.teamId)
  if (!teamId) throw new DraftValidationError({ teamId: "teamIdRequired" })
  const out: AgentTeamTaskPayload = { teamId }
  if (draft.ultracode) out.ultracode = true
  return out
}

export function goalDraftToPayload(draft: GoalDraft): GoalTaskPayload {
  const objective = trimOrUndef(draft.objective)
  if (!objective) throw new DraftValidationError({ objective: "objectiveRequired" })
  const out: GoalTaskPayload = { objective }
  const characterId = trimOrUndef(draft.characterId)
  if (characterId) out.characterId = characterId
  const config: NonNullable<GoalTaskPayload["config"]> = {}
  if (typeof draft.maxTurns === "number" && draft.maxTurns > 0) config.maxTurns = draft.maxTurns
  if (typeof draft.maxTokens === "number" && draft.maxTokens > 0) config.maxTokens = draft.maxTokens
  if (typeof draft.timeoutMinutes === "number" && draft.timeoutMinutes > 0)
    config.timeoutMs = draft.timeoutMinutes * 60_000
  if (Object.keys(config).length > 0) out.config = config
  return out
}

export function backgroundCommandDraftToPayload(
  draft: BackgroundCommandDraft
): BackgroundCommandTaskPayload {
  const command = trimOrUndef(draft.command)
  if (!command) throw new DraftValidationError({ command: "commandRequired" })
  const cwd = trimOrUndef(draft.cwd)
  // The executor resolves the command against `cwd`, and an unattended command
  // whose working directory is whatever the process happened to start in is a
  // different command each time. Required rather than defaulted for that reason.
  if (!cwd) throw new DraftValidationError({ cwd: "cwdRequired" })
  const out: BackgroundCommandTaskPayload = { command, cwd }
  const label = trimOrUndef(draft.label)
  if (label) out.label = label
  return out
}

export function planDraftToPayload(draft: PlanDraft): PlanTaskPayload {
  const planId = trimOrUndef(draft.planId)
  if (!planId) throw new DraftValidationError({ planId: "planIdRequired" })
  const out: PlanTaskPayload = { planId }
  if (draft.replanOnFailure) out.replanOnFailure = true
  return out
}

// ── workflow / im-push drafts ───────────────────────────────────────────────

export function payloadToWorkflowDraft(raw: unknown): WorkflowDraft {
  const draft: WorkflowDraft = { ...EMPTY_WORKFLOW_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.workflowId === "string") draft.workflowId = p.workflowId
  if (typeof p.environment === "string") draft.environment = p.environment
  if (typeof p.triggerId === "string") draft.triggerId = p.triggerId
  if (typeof p.idempotencyKey === "string") draft.idempotencyKey = p.idempotencyKey
  if (p.inputs !== undefined) {
    try {
      draft.inputsJson = JSON.stringify(p.inputs, null, 2)
    } catch {
      draft.inputsJson = ""
    }
  }
  return draft
}

export function workflowDraftToPayload(draft: WorkflowDraft): WorkflowTaskPayload {
  const errors: Record<string, string> = {}
  const workflowId = trimOrUndef(draft.workflowId)
  if (!workflowId) errors.workflowId = "workflowIdRequired"
  let inputs: unknown
  const inputsText = draft.inputsJson.trim()
  if (inputsText.length > 0) {
    try {
      inputs = JSON.parse(inputsText)
    } catch {
      errors.inputsJson = "inputsInvalidJson"
    }
  }
  if (Object.keys(errors).length > 0) throw new DraftValidationError(errors)
  const out: WorkflowTaskPayload = { workflowId: workflowId! }
  const environment = trimOrUndef(draft.environment)
  if (environment) out.environment = environment
  if (inputs !== undefined) out.inputs = inputs
  const triggerId = trimOrUndef(draft.triggerId)
  if (triggerId) out.triggerId = triggerId
  const idempotencyKey = trimOrUndef(draft.idempotencyKey)
  if (idempotencyKey) out.idempotencyKey = idempotencyKey
  return out
}

export function payloadToImPushDraft(raw: unknown): ImPushDraft {
  const draft: ImPushDraft = { ...EMPTY_IM_PUSH_DRAFT }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return draft
  const p = raw as Record<string, unknown>
  if (typeof p.conversationKey === "string") draft.conversationKey = p.conversationKey
  if (typeof p.text === "string") draft.text = p.text
  if (typeof p.idempotencyKey === "string") draft.idempotencyKey = p.idempotencyKey
  if (Array.isArray(p.segments)) {
    try {
      draft.segmentsJson = JSON.stringify(p.segments, null, 2)
    } catch {
      draft.segmentsJson = ""
    }
  }
  return draft
}

export function imPushDraftToPayload(draft: ImPushDraft): ImPushTaskPayload {
  const errors: Record<string, string> = {}
  const conversationKey = trimOrUndef(draft.conversationKey)
  if (!conversationKey) errors.conversationKey = "conversationKeyRequired"
  const text = trimOrUndef(draft.text)
  let segments: ImPushTaskPayload["segments"]
  const segmentsText = draft.segmentsJson.trim()
  if (segmentsText.length > 0) {
    try {
      const parsed = JSON.parse(segmentsText)
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        parsed.some((s) => !s || typeof s !== "object" || typeof s.type !== "string")
      ) {
        errors.segmentsJson = "segmentsInvalid"
      } else {
        segments = parsed as ImPushTaskPayload["segments"]
      }
    } catch {
      errors.segmentsJson = "segmentsInvalid"
    }
  }
  if (!text && !segments && !errors.segmentsJson) errors.text = "imPushTextRequired"
  if (Object.keys(errors).length > 0) throw new DraftValidationError(errors)
  const out: ImPushTaskPayload = { conversationKey: conversationKey! }
  if (segments) out.segments = segments
  else out.text = text
  const idempotencyKey = trimOrUndef(draft.idempotencyKey)
  if (idempotencyKey) out.idempotencyKey = idempotencyKey
  return out
}

/** Whether a task type uses the chat-like structured editor. */
export function isChatLikeTaskType(t: ScheduledTaskType): boolean {
  return t === "chat" || t === "agent" || t === "skill"
}

export function isStructuredEditableTaskType(t: ScheduledTaskType): boolean {
  return (
    isChatLikeTaskType(t) ||
    t === "background-command" ||
    t === "external-agent" ||
    t === "agent-team" ||
    t === "goal" ||
    t === "plan" ||
    t === "workflow" ||
    t === "im-push"
  )
}
