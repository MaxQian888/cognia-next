/**
 * Built-in node executors — registered on first import of this module.
 * Each Phase 4 base executor handles the bare minimum to enable
 * end-to-end runs in tests and the Run button:
 *   • trigger.manual — passthrough of trigger payload
 *   • flow.set — write a value into the run's static-data variable
 *   • flow.branch — evaluate a condition expression, emit a decision
 *   • data.transform — small in-memory map/filter/reduce
 *   • ai.prompt — direct LLM call via the existing provider router
 *
 * Phase 6 adds the rest of the catalog. Until then, unregistered kinds
 * surface as "no executor registered" run failures.
 */
import type { Goal, GoalConfig, GoalTemplate } from "@/types/goal"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskType,
  TaskExecution,
  TaskExecutionConfig,
  TaskNotificationConfig,
  TaskTrigger,
  TaskTriggerType,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import type {
  AgentPlan,
  CreatePlanStepInput,
  PlanConfig,
  PlanExecutionMode,
  PlanRefinementTrigger,
  PlanRefinementType,
  PlanSource,
  PlanStep,
  PlanStepKind,
  PlanStepStatus,
  UpdatePlanInput,
} from "@/types/agent/plan"
import type { StepExecutionContext, WorkflowNodeKind } from "@/types/workflow/visual"
import { resolveExpression } from "@/lib/workflow/runtime/expression"
import { deleteSkill } from "@/lib/db/skills"
import { deleteCharacter } from "@/lib/db/characters"
import { deleteTeam } from "@/lib/db/teams"

/** Coerce an extracted value to a declared type hint (best-effort). */
export function coerceToType(value: unknown, typeHint: string): unknown {
  const hint = typeHint.toLowerCase()
  if (value === null || value === undefined) return value
  if (hint.includes("number")) {
    const n = typeof value === "number" ? value : Number(value)
    return Number.isNaN(n) ? value : n
  }
  if (hint.includes("bool")) {
    if (typeof value === "boolean") return value
    if (typeof value === "string") return value.trim().toLowerCase() === "true"
    return Boolean(value)
  }
  if (hint.includes("string")) {
    return typeof value === "string" ? value : String(value)
  }
  return value
}

// ── built-in trigger pass-throughs ────────────────────────────────────────
// Trigger producers live outside the graph (Rust cron/webhook router or TS
// event bridges), but their nodes are still executable graph roots: they
// expose the event envelope to downstream expressions. Keep the side-effect-
// free execution contract in one function so every built-in producer behaves
// identically and adding a trigger cannot leave a catalog-only dormant node.
export const PASSTHROUGH_TRIGGER_KINDS = [
  "trigger.manual",
  "trigger.cron",
  "trigger.connector.inbound",
  "trigger.connector.system",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.webhook",
  "trigger.integration.event",
  "trigger.team",
  "trigger.workflow.completed",
] as const satisfies readonly WorkflowNodeKind[]

export async function runTriggerPassthrough(ctx: StepExecutionContext) {
  return {
    output: {
      firedAt: ctx.trigger.originAt,
      payload: ctx.trigger.payload,
    },
  }
}

// ── flow.loop ─────────────────────────────────────────────────────────────
// Iterator-style loop over an array (forEach), a fixed count (times), or a
// truthiness condition (while). Every mode is hard-capped at
// `maxIterations` (default 10000) to prevent runaway loops.
export const LOOP_HARD_CAP = 100_000

// ── flow.subworkflow ──────────────────────────────────────────────────────
// Recursively invoke another workflow as a step. The subworkflow runs in a
// fresh run id (so its events don't pollute the parent's timeline); the
// parent step's output is the subworkflow's terminal output. A hard depth
// limit (10) prevents pathological self-referential workflows from
// stack-overflowing.
export const MAX_SUBWORKFLOW_DEPTH = 10

// SHA-256 hash to hex (workflow-runtime helper, used by twin.ingest).
export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(text))
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Helper for executors that want to flag their failures as non-retryable
// (e.g., "missing required field" — retrying won't help).
export function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

export type WorkflowGoalSnapshot = Omit<Goal, "rawObjective" | "redactionMapEnc"> & {
  goalId: string
  hasRedactions: boolean
}

export type WorkflowGoalTemplateSnapshot = GoalTemplate & {
  templateId: string
}

export type WorkflowPlanSnapshot = AgentPlan & {
  planId: string
}

export type WorkflowScheduledTaskSnapshot = ScheduledTask & {
  taskId: string
}

export type WorkflowTaskExecutionSnapshot = TaskExecution & {
  executionId: string
}

export const SCHEDULER_TASK_TYPES = new Set<ScheduledTaskType>([
  "workflow",
  "agent",
  "sync",
  "backup",
  "custom",
  "plugin",
  "script",
  "test",
  "ai-generation",
  "chat",
  "im-push",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "twin",
  "connection:scheduled:digest",
  "connection:outbound:send",
  "wiki-rebuild",
])

export const SCHEDULER_TASK_STATUSES = new Set<ScheduledTaskStatus>([
  "active",
  "paused",
  "disabled",
  "expired",
])

export const SCHEDULER_TRIGGER_TYPES = new Set<TaskTriggerType>([
  "cron",
  "interval",
  "once",
  "event",
])

export const PLAN_STEP_KINDS = new Set<PlanStepKind>([
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
])

export const PLAN_STEP_STATUSES = new Set<PlanStepStatus>([
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
])

export const PLAN_REFINEMENT_TYPES = new Set<PlanRefinementType>([
  "optimize",
  "simplify",
  "expand",
  "reorder",
  "repair",
])

export const PLAN_REFINEMENT_TRIGGERS = new Set<PlanRefinementTrigger>([
  "manual",
  "step_failure",
  "judge_deviation",
])

export const PLAN_SOURCES = new Set<PlanSource>([
  "exit_plan_mode",
  "agent_tool",
  "planner_llm",
  "team_projection",
  "goal_projection",
  "manual",
])

export const PLAN_EXECUTION_MODES = new Set<PlanExecutionMode>([
  "in_session",
  "orchestrated",
  "auto",
])

export function toWorkflowGoal(goal: Goal | null | undefined): WorkflowGoalSnapshot | null {
  if (!goal) return null
  const { rawObjective: _rawObjective, redactionMapEnc, ...safe } = goal
  void _rawObjective
  return {
    ...safe,
    goalId: goal.id,
    hasRedactions: redactionMapEnc.length > 0,
  }
}

export function toWorkflowGoalTemplate(
  template: GoalTemplate | null | undefined
): WorkflowGoalTemplateSnapshot | null {
  if (!template) return null
  return { ...template, templateId: template.id }
}

export function toWorkflowPlan(plan: AgentPlan | null | undefined): WorkflowPlanSnapshot | null {
  if (!plan) return null
  return { ...plan, planId: plan.id }
}

export function toWorkflowScheduledTask(
  task: ScheduledTask | null | undefined
): WorkflowScheduledTaskSnapshot | null {
  if (!task) return null
  return { ...task, taskId: task.id }
}

export function toWorkflowTaskExecution(
  execution: TaskExecution | null | undefined
): WorkflowTaskExecutionSnapshot | null {
  if (!execution) return null
  return { ...execution, executionId: execution.id }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function parseJsonParam(raw: unknown, fieldName: string): unknown | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`${fieldName} must be valid JSON: ${message}`)
  }
}

export function parseObjectParam(
  structured: unknown,
  raw: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  const base = isRecord(structured) ? structured : undefined
  const parsed = parseJsonParam(raw, fieldName)
  if (parsed === undefined) return base
  if (!isRecord(parsed)) throw nonRetryable(`${fieldName} must decode to an object`)
  return { ...(base ?? {}), ...parsed }
}

export function buildSchedulerCreateInput(rawParams: unknown): CreateScheduledTaskInput {
  const params = isRecord(rawParams) ? rawParams : {}
  const name = readRequiredSchedulerString(params.name, "scheduler task name")
  return {
    name,
    ...(typeof params.description === "string" ? { description: params.description } : {}),
    type: normalizeSchedulerTaskType(params.type),
    trigger: buildSchedulerCreateTrigger(params),
    ...(parseSchedulerObjectParam(params.payload, params.payloadJson, "scheduler payloadJson")
      ? {
          payload: parseSchedulerObjectParam(
            params.payload,
            params.payloadJson,
            "scheduler payloadJson"
          ),
        }
      : {}),
    ...(parseSchedulerConfig(params) ? { config: parseSchedulerConfig(params) } : {}),
    ...(parseSchedulerNotification(params)
      ? { notification: parseSchedulerNotification(params) }
      : {}),
    ...(normalizeStringList(params.tags, params.tagsRaw)
      ? { tags: normalizeStringList(params.tags, params.tagsRaw) }
      : {}),
    ...(normalizeSchedulerDate(params.endAt, "scheduler endAt")
      ? { endAt: normalizeSchedulerDate(params.endAt, "scheduler endAt") }
      : {}),
    ...(normalizeStringList(params.onSuccessTaskIds, params.onSuccessTaskIdsRaw)
      ? {
          onSuccessTaskIds: normalizeStringList(
            params.onSuccessTaskIds,
            params.onSuccessTaskIdsRaw
          ),
        }
      : {}),
    ...(normalizeStringList(params.onFailureTaskIds, params.onFailureTaskIdsRaw)
      ? {
          onFailureTaskIds: normalizeStringList(
            params.onFailureTaskIds,
            params.onFailureTaskIdsRaw
          ),
        }
      : {}),
  }
}

export function buildSchedulerUpdateInput(rawParams: unknown): UpdateScheduledTaskInput {
  const params = isRecord(rawParams) ? rawParams : {}
  const patch: UpdateScheduledTaskInput = {}
  if (params.name !== undefined) {
    patch.name = readRequiredSchedulerString(params.name, "scheduler task name")
  }
  if (typeof params.description === "string") patch.description = params.description
  const status = normalizeOptionalSchedulerStatus(params.status)
  if (status) patch.status = status
  const trigger = buildSchedulerUpdateTrigger(params)
  if (trigger) patch.trigger = trigger
  const payload = parseSchedulerObjectParam(
    params.payload,
    params.payloadJson,
    "scheduler payloadJson"
  )
  if (payload) patch.payload = payload
  const config = parseSchedulerConfig(params)
  if (config) patch.config = config
  const notification = parseSchedulerNotification(params)
  if (notification) patch.notification = notification
  const tags = normalizeStringList(params.tags, params.tagsRaw)
  if (tags) patch.tags = tags
  if (params.clearEndAt === true) {
    patch.endAt = null
  } else {
    const endAt = normalizeSchedulerDate(params.endAt, "scheduler endAt")
    if (endAt) patch.endAt = endAt
  }
  const onSuccessTaskIds = normalizeStringList(params.onSuccessTaskIds, params.onSuccessTaskIdsRaw)
  if (onSuccessTaskIds) patch.onSuccessTaskIds = onSuccessTaskIds
  const onFailureTaskIds = normalizeStringList(params.onFailureTaskIds, params.onFailureTaskIdsRaw)
  if (onFailureTaskIds) patch.onFailureTaskIds = onFailureTaskIds
  return patch
}

export function buildSchedulerCreateTrigger(params: Record<string, unknown>): TaskTrigger {
  const type = normalizeSchedulerTriggerType(params.triggerType)
  const trigger: TaskTrigger = { type }
  applySchedulerTriggerFields(trigger, params, true)
  return trigger
}

export function buildSchedulerUpdateTrigger(
  params: Record<string, unknown>
): Partial<TaskTrigger> | undefined {
  const trigger: Partial<TaskTrigger> = {}
  if (typeof params.triggerType === "string" && params.triggerType.trim()) {
    trigger.type = normalizeSchedulerTriggerType(params.triggerType)
  }
  applySchedulerTriggerFields(trigger, params, false)
  return Object.keys(trigger).length > 0 ? trigger : undefined
}

export function applySchedulerTriggerFields(
  trigger: Partial<TaskTrigger>,
  params: Record<string, unknown>,
  requireForType: boolean
): void {
  const type = trigger.type
  if (type === "cron") {
    const cronExpression = normalizeOptionalString(params.cronExpression)
    if (cronExpression) trigger.cronExpression = cronExpression
    else if (requireForType) throw nonRetryable("scheduler cron trigger requires 'cronExpression'")
  }
  if (type === "interval") {
    const intervalMs = normalizeOptionalPositiveNumber(params.intervalMs, "intervalMs")
    if (intervalMs !== undefined) trigger.intervalMs = intervalMs
    else if (requireForType) throw nonRetryable("scheduler interval trigger requires 'intervalMs'")
  }
  if (type === "once") {
    const runAt = normalizeSchedulerDate(params.runAt, "scheduler runAt")
    if (runAt) trigger.runAt = runAt
    else if (requireForType) throw nonRetryable("scheduler once trigger requires 'runAt'")
  }
  if (type === "event") {
    const eventType = normalizeOptionalString(params.eventType)
    if (eventType) trigger.eventType = eventType
    else if (requireForType) throw nonRetryable("scheduler event trigger requires 'eventType'")
  }
  const eventSource = normalizeOptionalString(params.eventSource)
  if (eventSource) trigger.eventSource = eventSource
  const timezone = normalizeOptionalString(params.timezone)
  if (timezone) trigger.timezone = timezone
  const dependsOn = normalizeStringList(params.dependsOn, params.dependsOnRaw)
  if (dependsOn) trigger.dependsOn = dependsOn
  const jitterMs = normalizeOptionalNonNegativeNumber(params.jitterMs, "jitterMs")
  if (jitterMs !== undefined) trigger.jitterMs = jitterMs
}

export function parseSchedulerObjectParam(
  structured: unknown,
  raw: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  const parsed = parseObjectParam(structured, raw, fieldName)
  return parsed && Object.keys(parsed).length > 0 ? parsed : undefined
}

export function parseSchedulerImportData(
  structured: unknown,
  raw: unknown
): { version: number; tasks: ScheduledTask[] } {
  const parsed = structured ?? parseJsonParam(raw, "scheduler import dataJson")
  if (!isRecord(parsed)) {
    throw nonRetryable("action.scheduler.task.import requires 'dataJson'")
  }
  return parsed as { version: number; tasks: ScheduledTask[] }
}

export function parseSchedulerConfig(
  rawParams: Record<string, unknown>
): Partial<TaskExecutionConfig> | undefined {
  return parseSchedulerObjectParam(
    rawParams.config,
    rawParams.configJson,
    "scheduler configJson"
  ) as Partial<TaskExecutionConfig> | undefined
}

export function parseSchedulerNotification(
  rawParams: Record<string, unknown>
): Partial<TaskNotificationConfig> | undefined {
  return parseSchedulerObjectParam(
    rawParams.notification,
    rawParams.notificationJson,
    "scheduler notificationJson"
  ) as Partial<TaskNotificationConfig> | undefined
}

export function normalizeSchedulerTaskType(value: unknown): ScheduledTaskType {
  if (typeof value === "string" && SCHEDULER_TASK_TYPES.has(value as ScheduledTaskType)) {
    return value as ScheduledTaskType
  }
  throw nonRetryable(`unsupported scheduler task type: ${String(value)}`)
}

export function normalizeSchedulerTriggerType(value: unknown): TaskTriggerType {
  if (typeof value === "string" && SCHEDULER_TRIGGER_TYPES.has(value as TaskTriggerType)) {
    return value as TaskTriggerType
  }
  throw nonRetryable(`unsupported scheduler trigger type: ${String(value)}`)
}

export function normalizeOptionalSchedulerStatus(value: unknown): ScheduledTaskStatus | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value === "string" && SCHEDULER_TASK_STATUSES.has(value as ScheduledTaskStatus)) {
    return value as ScheduledTaskStatus
  }
  throw nonRetryable(`unsupported scheduler task status: ${String(value)}`)
}

export function normalizeSchedulerStatuses(
  values: unknown,
  raw: unknown
): ScheduledTaskStatus[] | undefined {
  const list = normalizeStringList(values, raw)
  if (!list) return undefined
  return list.map((value) => {
    if (!SCHEDULER_TASK_STATUSES.has(value as ScheduledTaskStatus)) {
      throw nonRetryable(`unsupported scheduler task status: ${value}`)
    }
    return value as ScheduledTaskStatus
  })
}

export function normalizeSchedulerTypes(
  values: unknown,
  raw: unknown
): ScheduledTaskType[] | undefined {
  const list = normalizeStringList(values, raw)
  if (!list) return undefined
  return list.map((value) => normalizeSchedulerTaskType(value))
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function readRequiredSchedulerString(value: unknown, fieldName: string): string {
  const text = normalizeOptionalString(value)
  if (!text) throw nonRetryable(`${fieldName} must be a non-empty string`)
  return text
}

export function normalizeStringList(values: unknown, raw: unknown): string[] | undefined {
  if (Array.isArray(values)) {
    const normalized = values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
    return normalized.length > 0 || values.length === 0 ? normalized : undefined
  }
  const text = normalizeOptionalString(raw)
  if (!text) return undefined
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

export function normalizeSchedulerDate(value: unknown, fieldName: string): Date | undefined {
  const text = normalizeOptionalString(value)
  if (!text) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw nonRetryable(`${fieldName} must be a valid date`)
  return date
}

export function normalizeOptionalPositiveNumber(
  value: unknown,
  fieldName: string
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw nonRetryable(`${fieldName} must be a positive number`)
  }
  return parsed
}

export function parsePlanConfig(params: {
  config?: Record<string, unknown>
  configJson?: string
}): Partial<PlanConfig> | undefined {
  const config = parseObjectParam(params.config, params.configJson, "plan configJson")
  return config && Object.keys(config).length > 0 ? (config as Partial<PlanConfig>) : undefined
}

export function parsePlanMetadata(params: {
  metadata?: Record<string, unknown>
  metadataJson?: string
}): Record<string, unknown> | undefined {
  const metadata = parseObjectParam(params.metadata, params.metadataJson, "plan metadataJson")
  return metadata && Object.keys(metadata).length > 0 ? metadata : undefined
}

export function parsePlanCreateSteps(params: {
  steps?: unknown
  stepsJson?: string
}): CreatePlanStepInput[] {
  const parsed = params.steps ?? parseJsonParam(params.stepsJson, "plan stepsJson")
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw nonRetryable("action.plan.create requires a non-empty steps array")
  }
  return parsed.map((step, index) => normalizePlanCreateStep(step, index))
}

export function normalizePlanCreateStep(step: unknown, index: number): CreatePlanStepInput {
  if (!isRecord(step)) throw nonRetryable(`plan step ${index} must be an object`)
  const title = readRequiredPlanString(step.title, `plan step ${index}.title`)
  const kind = normalizePlanStepKind(step.kind)
  const dependsOn = normalizePlanDependsOn(step.dependsOn, index)
  const params = isRecord(step.params) ? (step.params as CreatePlanStepInput["params"]) : undefined
  const estimatedDurationMs = normalizeOptionalNonNegativeNumber(
    step.estimatedDurationMs,
    `plan step ${index}.estimatedDurationMs`
  )
  return {
    title,
    kind,
    ...(typeof step.description === "string" ? { description: step.description } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(params ? { params } : {}),
    ...(estimatedDurationMs !== undefined ? { estimatedDurationMs } : {}),
  }
}

export function parsePlanUpdateSteps(params: {
  steps?: unknown
  stepsJson?: string
}): PlanStep[] | undefined {
  const parsed = params.steps ?? parseJsonParam(params.stepsJson, "plan stepsJson")
  if (parsed === undefined) return undefined
  if (!Array.isArray(parsed)) throw nonRetryable("plan stepsJson must decode to an array")
  return parsed.map((step, index) => normalizePlanStep(step, index))
}

export function normalizePlanStep(step: unknown, index: number): PlanStep {
  if (!isRecord(step)) throw nonRetryable(`plan step ${index} must be an object`)
  const id = readRequiredPlanString(step.id, `plan step ${index}.id`)
  const title = readRequiredPlanString(step.title, `plan step ${index}.title`)
  const kind = normalizePlanStepKind(step.kind)
  const status = normalizePlanStepStatus(step.status)
  const order = normalizeRequiredInteger(step.order, `plan step ${index}.order`)
  const dependencies = normalizeStringArray(step.dependencies, `plan step ${index}.dependencies`)
  return {
    ...(step as unknown as PlanStep),
    id,
    title,
    kind,
    status,
    order,
    dependencies,
  }
}

export function buildPlanDraftPatch(params: {
  title?: string
  description?: string
  executionMode?: PlanExecutionMode | ""
  steps?: unknown
  stepsJson?: string
  config?: Record<string, unknown>
  configJson?: string
  metadata?: Record<string, unknown>
  metadataJson?: string
}): UpdatePlanInput {
  const patch: UpdatePlanInput = {}
  if (params.title !== undefined) patch.title = params.title
  if (params.description !== undefined) patch.description = params.description
  if (params.executionMode) patch.executionMode = normalizePlanExecutionMode(params.executionMode)
  const steps = parsePlanUpdateSteps(params)
  if (steps !== undefined) patch.steps = steps
  const config = parsePlanConfig(params)
  if (config !== undefined) patch.config = config
  const metadata = parsePlanMetadata(params)
  if (metadata !== undefined) patch.metadata = metadata
  return patch
}

export function buildPlanStepPatch(params: {
  result?: string
  error?: string
  outputJson?: string
  output?: unknown
  attempts?: number
}): Partial<Omit<PlanStep, "id" | "status">> {
  const patch: Partial<Omit<PlanStep, "id" | "status">> = {}
  if (params.result !== undefined) patch.result = params.result
  if (params.error !== undefined) patch.error = params.error
  const parsedOutput = parseJsonParam(params.outputJson, "plan step outputJson")
  if (parsedOutput !== undefined) patch.output = parsedOutput
  else if (params.output !== undefined) patch.output = params.output
  if (params.attempts !== undefined) {
    patch.attempts = normalizeRequiredInteger(params.attempts, "attempts")
  }
  return patch
}

export function readRequiredPlanString(value: unknown, fieldName: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw nonRetryable(`${fieldName} must be a non-empty string`)
  return text
}

export function normalizeRequiredInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw nonRetryable(`${fieldName} must be a non-negative integer`)
  }
  return parsed
}

export function normalizeOptionalNonNegativeNumber(
  value: unknown,
  fieldName: string
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw nonRetryable(`${fieldName} must be a non-negative number`)
  }
  return parsed
}

export function normalizePlanDependsOn(value: unknown, stepIndex: number): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw nonRetryable(`plan step ${stepIndex}.dependsOn must be an array`)
  return value.map((item, depIndex) => {
    const parsed = Number(item)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw nonRetryable(
        `plan step ${stepIndex}.dependsOn[${depIndex}] must be a non-negative integer`
      )
    }
    return parsed
  })
}

export function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw nonRetryable(`${fieldName} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== "string") throw nonRetryable(`${fieldName}[${index}] must be a string`)
    return item
  })
}

export function normalizePlanStepKind(value: unknown): PlanStepKind {
  if (typeof value === "string" && PLAN_STEP_KINDS.has(value as PlanStepKind)) {
    return value as PlanStepKind
  }
  throw nonRetryable(`unsupported plan step kind: ${String(value)}`)
}

export function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  if (typeof value === "string" && PLAN_STEP_STATUSES.has(value as PlanStepStatus)) {
    return value as PlanStepStatus
  }
  throw nonRetryable(`unsupported plan step status: ${String(value)}`)
}

export function normalizePlanRefinementType(value: unknown): PlanRefinementType {
  if (value === undefined || value === "") return "optimize"
  if (typeof value === "string" && PLAN_REFINEMENT_TYPES.has(value as PlanRefinementType)) {
    return value as PlanRefinementType
  }
  throw nonRetryable(`unsupported plan refinementType: ${String(value)}`)
}

export function normalizePlanRefinementTrigger(value: unknown): PlanRefinementTrigger {
  if (value === undefined || value === "") return "manual"
  if (typeof value === "string" && PLAN_REFINEMENT_TRIGGERS.has(value as PlanRefinementTrigger)) {
    return value as PlanRefinementTrigger
  }
  throw nonRetryable(`unsupported plan refinement trigger: ${String(value)}`)
}

export function normalizePlanSource(value: unknown): PlanSource {
  if (typeof value === "string" && PLAN_SOURCES.has(value as PlanSource)) {
    return value as PlanSource
  }
  return "manual"
}

export function normalizePlanExecutionMode(value: unknown): PlanExecutionMode {
  if (typeof value === "string" && PLAN_EXECUTION_MODES.has(value as PlanExecutionMode)) {
    return value as PlanExecutionMode
  }
  throw nonRetryable(`unsupported plan executionMode: ${String(value)}`)
}

export function parseGoalConfig(params: {
  config?: Record<string, unknown>
  configJson?: string
}): Partial<GoalConfig> {
  const config =
    params.config && typeof params.config === "object" && !Array.isArray(params.config)
      ? params.config
      : {}
  const raw = typeof params.configJson === "string" ? params.configJson.trim() : ""
  if (!raw) return config as Partial<GoalConfig>
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`goal configJson must be valid JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw nonRetryable("goal configJson must decode to an object")
  }
  return { ...config, ...(parsed as Record<string, unknown>) } as Partial<GoalConfig>
}

export function parseGoalTemplateConfig(params: {
  configOverrides?: Record<string, unknown>
  configJson?: string
}): Partial<GoalConfig> | undefined {
  const config =
    params.configOverrides &&
    typeof params.configOverrides === "object" &&
    !Array.isArray(params.configOverrides)
      ? params.configOverrides
      : {}
  const raw = typeof params.configJson === "string" ? params.configJson.trim() : ""
  if (!raw) {
    return Object.keys(config).length > 0 ? (config as Partial<GoalConfig>) : undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`goal template configJson must be valid JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw nonRetryable("goal template configJson must decode to an object")
  }
  return { ...config, ...(parsed as Record<string, unknown>) } as Partial<GoalConfig>
}

export function requireGoalId(ctx: StepExecutionContext, nodeName: string): string {
  const goalId = String((ctx.params as { goalId?: unknown }).goalId ?? "").trim()
  if (!goalId) throw nonRetryable(`${nodeName} requires 'goalId'`)
  return goalId
}

export function requireGoalTemplateId(ctx: StepExecutionContext, nodeName: string): string {
  const templateId = String((ctx.params as { templateId?: unknown }).templateId ?? "").trim()
  if (!templateId) throw nonRetryable(`${nodeName} requires 'templateId'`)
  return templateId
}

export function requireGoalSessionId(value: unknown, nodeName: string): string {
  const sessionId = String(value ?? "").trim()
  if (!sessionId) throw nonRetryable(`${nodeName} requires 'sessionId'`)
  return sessionId
}

export function requirePlanId(ctx: StepExecutionContext, nodeName: string): string {
  const planId = String((ctx.params as { planId?: unknown }).planId ?? "").trim()
  if (!planId) throw nonRetryable(`${nodeName} requires 'planId'`)
  return planId
}

export function requireSchedulerTaskId(ctx: StepExecutionContext, nodeName: string): string {
  const taskId = String((ctx.params as { taskId?: unknown }).taskId ?? "").trim()
  if (!taskId) throw nonRetryable(`${nodeName} requires 'taskId'`)
  return taskId
}

export function requireSchedulerExecutionId(ctx: StepExecutionContext, nodeName: string): string {
  const executionId = String((ctx.params as { executionId?: unknown }).executionId ?? "").trim()
  if (!executionId) throw nonRetryable(`${nodeName} requires 'executionId'`)
  return executionId
}

export function requirePlanSessionId(value: unknown, nodeName: string): string {
  const sessionId = String(value ?? "").trim()
  if (!sessionId) throw nonRetryable(`${nodeName} requires 'sessionId'`)
  return sessionId
}

export function clampGoalLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

export function clampGoalEventLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

export function clampGoalTemplateLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

export function clampPlanLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

export function clampPlanEventLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

export function clampSchedulerTaskLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

export function clampSchedulerExecutionLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

export function applyGoalLimit(goals: Goal[], limit: number): Goal[] {
  return goals.length > limit ? goals.slice(0, limit) : goals
}

export async function goalLifecycleOutput(
  ctx: StepExecutionContext,
  nodeName: string,
  mutate: (goalId: string) => Promise<Goal | null>
) {
  const goalId = requireGoalId(ctx, nodeName)
  const goal = await mutate(goalId)
  return { output: { goalId, goal: toWorkflowGoal(goal) } }
}

// Suppress unused-import warning when only one of these helpers is exercised
// by the test suite — both are real call sites in production paths.
void deleteSkill

void deleteCharacter

void deleteTeam

// ── helpers ───────────────────────────────────────────────────────────────

export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value)
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

export function firstUpstream(ctx: StepExecutionContext): unknown {
  const values = Object.values(ctx.upstream)
  return values.length > 0 ? values[0] : undefined
}

/**
 * Evaluate a per-item transform expression. Item exposed as `$item`. Falls
 * back to the raw item when the expression is empty.
 */
export function evalItemExpression(
  expression: string,
  item: unknown,
  ctx: StepExecutionContext
): unknown {
  if (!expression) return item
  return resolveExpression(expression, {
    upstream: { ...ctx.upstream, $item: item },
    trigger: ctx.trigger,
    staticData: {},
    params: ctx.params as Record<string, unknown>,
  })
}

/**
 * Compile a custom reducer for `data.aggregate`'s custom op. The body is a JS
 * *expression* returning the next accumulator, with `acc` / `item` / `index`
 * (and read-only `upstream` / `trigger`) in scope — same sandbox shape as
 * `data.code`. Compiled once per run, applied per item.
 */
export function compileReducer(
  expression: string
): (acc: unknown, item: unknown, index: number, upstream: unknown, trigger: unknown) => unknown {
  return new Function(
    "acc",
    "item",
    "index",
    "upstream",
    "trigger",
    `"use strict"; return (${expression});`
  ) as (acc: unknown, item: unknown, index: number, upstream: unknown, trigger: unknown) => unknown
}

/** Stable key for value-equality (order-insensitive object keys). */
export function stableKey(value: unknown): string {
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(norm)
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k])
    return out
  }
  try {
    return JSON.stringify(norm(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

export type AggregateOperation =
  "collect" | "concat" | "merge-objects" | "group-by" | "dedupe" | "numeric" | "custom"

export interface AggregateParams {
  operation?: AggregateOperation
  /** group-by / dedupe: per-item key expression (without `{{ }}`). */
  keyExpression?: string
  /** numeric: per-item value expression; empty ⇒ the item itself. */
  numericField?: string
  numericOp?: "sum" | "avg" | "min" | "max" | "count"
  /** custom: reducer expression with `$acc`/`$item`/`$index` in scope. */
  reducerExpression?: string
  /** custom: seed accumulator. */
  initialValue?: unknown
}

/**
 * Core reduce/aggregate over a value array. Shared by `data.aggregate`, the
 * `data.transform` reduce delegation, and `flow.join`'s gather→reduce option.
 */
export function aggregateArray(
  arr: unknown[],
  params: AggregateParams,
  ctx: StepExecutionContext
): unknown {
  const operation = params.operation ?? "collect"
  switch (operation) {
    case "collect":
      return [...arr]
    case "concat":
      return arr.flatMap((x) => (Array.isArray(x) ? x : [x]))
    case "merge-objects":
      return arr.reduce<Record<string, unknown>>((acc, x) => {
        if (x && typeof x === "object" && !Array.isArray(x)) {
          return { ...acc, ...(x as Record<string, unknown>) }
        }
        return acc
      }, {})
    case "group-by": {
      const expr = params.keyExpression?.trim() ?? ""
      const out: Record<string, unknown[]> = {}
      for (const item of arr) {
        const key = String(evalItemExpression(expr, item, ctx) ?? "")
        ;(out[key] ??= []).push(item)
      }
      return out
    }
    case "dedupe": {
      const expr = params.keyExpression?.trim() ?? ""
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const item of arr) {
        const key = stableKey(expr ? evalItemExpression(expr, item, ctx) : item)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(item)
        }
      }
      return out
    }
    case "numeric": {
      const op = params.numericOp ?? "sum"
      if (op === "count") return arr.length
      const field = params.numericField?.trim() ?? ""
      const nums = arr
        .map((item) => (field ? evalItemExpression(field, item, ctx) : item))
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      switch (op) {
        case "sum":
          return nums.reduce((a, b) => a + b, 0)
        case "avg":
          return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null
        case "min":
          return nums.length > 0 ? Math.min(...nums) : null
        case "max":
          return nums.length > 0 ? Math.max(...nums) : null
        default:
          return null
      }
    }
    case "custom": {
      const expr = params.reducerExpression?.trim() ?? ""
      if (!expr) return params.initialValue
      let fn: ReturnType<typeof compileReducer>
      try {
        fn = compileReducer(expr)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const wrapped = new Error(
          `data.aggregate custom reducer is not a valid expression: ${message}`
        ) as Error & { retryable?: boolean }
        wrapped.retryable = false
        throw wrapped
      }
      let acc = params.initialValue
      arr.forEach((item, index) => {
        try {
          acc = fn(acc, item, index, ctx.upstream, ctx.trigger)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const wrapped = new Error(`data.aggregate custom reducer failed: ${message}`) as Error & {
            retryable?: boolean
          }
          wrapped.retryable = false
          throw wrapped
        }
      })
      return acc
    }
    default:
      throw new Error(`Unsupported aggregate operation: ${operation}`)
  }
}

/**
 * Resolve the array `data.aggregate` operates on: a single array upstream is
 * used as-is; a single scalar upstream is wrapped; multiple upstreams (a
 * fan-in) are aggregated as the set of their outputs.
 */
export function resolveAggregateInput(ctx: StepExecutionContext): unknown[] {
  const values = Object.values(ctx.upstream)
  if (values.length === 0) return []
  if (values.length === 1) {
    const v = values[0]
    return Array.isArray(v) ? v : [v]
  }
  return values
}

/**
 * Evaluate a `flow.loop.while` condition with the iteration count exposed.
 * Both `$item` (the raw index) and `$loop.index` resolve to the current `i`.
 */
export function evalLoopExpression(
  expression: string,
  iteration: number,
  ctx: StepExecutionContext
): unknown {
  return resolveExpression(expression, {
    upstream: {
      ...ctx.upstream,
      $item: iteration,
      $loop: { index: iteration },
    },
    trigger: ctx.trigger,
    staticData: {},
    params: ctx.params as Record<string, unknown>,
  })
}
