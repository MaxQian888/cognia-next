/**
 * Per-kind zod schemas for `node.data.params`. Powers the inspector's
 * field-level validation hints + the "block run on errors" gate in the
 * canvas. Independent from the orchestrator's runtime checks — those still
 * apply at execution time.
 *
 * Errors are surfaced via stable i18n keys (NOT english strings) so the
 * inspector can translate them at render time. The `params` object that
 * comes back from `safeParse` is discarded — only the issue list matters,
 * so unknown keys don't need to be preserved in the parsed output.
 */

import { z } from "zod"
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"

/**
 * Cron field accepts the standard 5-field expression (minute hour dom mon dow).
 * We do NOT use a full cron parser here — that would balloon the bundle and
 * the orchestrator's cron-parser is the authoritative source. This is just
 * a sanity check so users don't ship "every monday" as a value.
 */
const cronExprRegex = /^\s*(\S+\s+){4}\S+\s*$/

function requiredString(messageKey = "required") {
  return z.string().min(1, messageKey)
}

const optionalString = z.string().optional()

function numberRange(min?: number, max?: number) {
  let s = z.number()
  if (min !== undefined) s = s.min(min, "minValue")
  if (max !== undefined) s = s.max(max, "maxValue")
  return s
}

function positiveInteger() {
  return z.number().int().min(1, "minValue")
}

/**
 * Accepts an http(s) URL or any value containing a `{{ … }}` expression
 * (resolved at run time, so we can't validate the final shape here). Empty
 * strings pass — required-ness is enforced separately so this only checks
 * format when a literal URL is present.
 */
function isHttpUrlOrExpression(value: string): boolean {
  if (value.length === 0 || value.includes("{{")) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

// ── Triggers ────────────────────────────────────────────────────────────────

const ManualTriggerParams = z.object({
  // Declared input schema for the published interface (D5).
  inputSchema: z.record(z.string(), z.unknown()).optional(),
})

const CronParams = z.object({
  cron: requiredString("required").regex(cronExprRegex, "cronExpr"),
  timezone: optionalString,
})

export const CONNECTOR_SYSTEM_EVENT_KINDS = [
  "reaction_added",
  "reaction_removed",
  "poke",
  "request",
  "lifecycle",
] as const

const ConnectorSystemTriggerParams = z.object({
  adapterId: requiredString("required"),
  conversationKey: optionalString,
  /** Only fire for these system kinds (OR); empty = every kind. */
  kinds: z.array(z.enum(CONNECTOR_SYSTEM_EVENT_KINDS)).optional(),
  /**
   * Only fire when the target message (reaction / poke) was one the bot
   * itself delivered — resolved from the delivered-message ledger.
   */
  targetSelfOnly: z.boolean().optional(),
})

const ConnectorInboundParams = z.object({
  adapterId: requiredString("required"),
  conversationKey: optionalString,
  characterId: optionalString,
  // Fine-grained event filters (all optional — an unscoped node keeps the
  // legacy "every inbound on this adapter" behaviour). Matching happens in
  // `lib/workflow/runtime/trigger-subscriptions.ts:matches`.
  /** Only fire for these platform sender ids (OR). */
  senderIds: z.array(z.string()).optional(),
  /** Only fire for these channel kinds (private / group / channel / thread). */
  channelKinds: z.array(z.enum(["private", "group", "channel", "thread"])).optional(),
  /** Case-insensitive substring keywords (OR) against the message plain text. */
  keywords: z.array(z.string()).optional(),
  /** Only fire when the bot itself is @-mentioned. */
  requireMention: z.boolean().optional(),
})

const ChatMessageTriggerParams = z.object({
  characterId: requiredString("required"),
  sessionId: optionalString,
})

const GoalCompletedTriggerParams = z.object({
  // All optional — an unscoped node fires for every goal that reaches a
  // terminal status. Scope by goal, session, character, or terminal status.
  goalId: optionalString,
  sessionId: optionalString,
  characterId: optionalString,
  status: optionalString,
})

const TeamTriggerParams = z.object({
  // All optional — an unscoped node fires for every team run that reaches a
  // terminal status. Scope by team and/or terminal status.
  teamId: optionalString,
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
})

const WorkflowCompletedTriggerParams = z.object({
  // Both optional — an unscoped node fires for EVERY workflow's terminal run
  // (self-triggering is rejected by the fanout emitter). `workflowId` scopes
  // to one source workflow; `status` to one outcome. The empty string is the
  // editor's "any" sentinel (patchParam stores "" rather than deleting), so
  // the enum must tolerate it alongside absence.
  workflowId: optionalString,
  status: z.union([z.enum(["succeeded", "failed"]), z.literal("")]).optional(),
})

/** Lifecycle kinds `trigger.pet.event` may subscribe to. */
export const PET_TRIGGER_KINDS = ["levelUp", "evolved", "achievementUnlocked", "unwell"] as const

const PetEventTriggerParams = z.object({
  // Unscoped = any of the four lifecycle kinds.
  kinds: z.array(z.enum(PET_TRIGGER_KINDS)).optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
})

const PetInteractActionParams = z.object({
  kind: z.enum(["fed", "played", "petted", "talked", "slept", "cleaned", "treated"]),
  // Optional shop-item id — the controller applies the item's restore.
  itemId: optionalString,
})

const WebhookTriggerParams = z.object({
  path: requiredString("required").regex(/^[a-z0-9][a-z0-9-_/]*$/i, "webhookPath"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]).optional(),
  hmacSecret: optionalString,
  responseStatus: numberRange(100, 599).optional(),
  responseTemplate: optionalString,
})

const IntegrationEventTriggerParams = z.object({
  pluginId: optionalString,
  integrationId: optionalString,
  accountId: optionalString,
  eventTypes: z.array(z.string().min(1)).optional(),
  resourceKind: optionalString,
  resourceId: optionalString,
})

// ── Actions: characters / teams / skills ────────────────────────────────────

const CharacterSendParams = z.object({
  characterId: requiredString("required"),
  content: requiredString("required"),
  sessionId: optionalString,
})

const CharacterCreateParams = z.object({
  name: requiredString("required"),
  systemPrompt: requiredString("required"),
  description: optionalString,
  avatarColor: optionalString,
  avatarEmoji: optionalString,
  model: optionalString,
})

const CharacterUpdateParams = z.object({
  characterId: requiredString("required"),
  patchJson: optionalString,
  patch: z.record(z.string(), z.unknown()).optional(),
})

const AgentTurnParams = z.object({
  prompt: requiredString("required"),
  characterId: optionalString,
  systemPrompt: optionalString,
  model: optionalString,
  allowedTools: z.array(z.string()).optional(),
  maxTurns: numberRange(1, 100).optional(),
  temperature: numberRange(0, 2).optional(),
  timeoutMs: numberRange(1000, 3_600_000).optional(),
  toolsEnabled: z.boolean().optional(),
  requireTools: z.boolean().optional(),
  cwd: optionalString,
  // Typed output (D3): JSON object schema the reply must satisfy.
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  onSchemaViolation: z.enum(["fail", "soft"]).optional(),
  piiGate: z.enum(["block", "redact"]).optional(),
})

// ── Actions: goals ─────────────────────────────────────────────────────────

const GoalCreateParams = z.object({
  sessionId: requiredString("required"),
  rawObjective: requiredString("required"),
  characterId: optionalString,
  startPaused: z.boolean().optional(),
  configJson: optionalString,
  config: z.record(z.string(), z.unknown()).optional(),
})

const GoalIdParams = z.object({
  goalId: requiredString("required"),
})

const GoalListParams = z
  .object({
    mode: z.enum(["all", "session", "activeForSession", "openForSession"]).optional(),
    sessionId: optionalString,
    limit: numberRange(1, 1000).optional(),
  })
  .refine(
    (v) => {
      const mode = v.mode ?? "all"
      return mode === "all" || (typeof v.sessionId === "string" && v.sessionId.length > 0)
    },
    { message: "required", path: ["sessionId"] }
  )

const GoalEventsParams = GoalIdParams.extend({
  limit: numberRange(1, 5000).optional(),
})

const GoalUpdateObjectiveParams = GoalIdParams.extend({
  rawObjective: requiredString("required"),
})

const GoalUpdateConfigParams = GoalIdParams.extend({
  configJson: optionalString,
  config: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (v) =>
    (typeof v.configJson === "string" && v.configJson.trim() !== "") ||
    (v.config !== undefined && Object.keys(v.config).length > 0),
  { message: "required", path: ["configJson"] }
)

const GoalToggleSubgoalParams = GoalIdParams.extend({
  subgoalId: requiredString("required"),
})

const GoalAnalyticsParams = z
  .object({
    scope: z.enum(["all", "session"]).optional(),
    sessionId: optionalString,
    limit: numberRange(1, 1000).optional(),
    windowDays: numberRange(1, 366).optional(),
  })
  .refine(
    (v) => (v.scope ?? "all") !== "session" || (typeof v.sessionId === "string" && v.sessionId),
    { message: "required", path: ["sessionId"] }
  )

const GoalTemplateIdParams = z.object({
  templateId: requiredString("required"),
})

const GoalTemplateListParams = z.object({
  includeBuiltIn: z.boolean().optional(),
  favoriteOnly: z.boolean().optional(),
  query: optionalString,
  limit: numberRange(1, 1000).optional(),
})

const GoalTemplateCreateGoalParams = GoalTemplateIdParams.extend({
  sessionId: requiredString("required"),
  characterId: optionalString,
})

const GoalTemplateUpsertParams = z.object({
  templateId: optionalString,
  title: requiredString("required"),
  objectiveText: requiredString("required"),
  configJson: optionalString,
  configOverrides: z.record(z.string(), z.unknown()).optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().optional(),
})

const GoalTemplateFavoriteParams = GoalTemplateIdParams.extend({
  isFavorite: z.boolean(),
})

const TeamRunParams = z.object({
  teamId: requiredString("required"),
  goal: requiredString("required"),
})

const MemoryRecallParams = z.object({
  query: requiredString("required"),
  topK: numberRange(1, 50).optional(),
  scope: z.enum(["global", "workspace", "character", "agent"]).optional(),
  characterId: optionalString,
  projectId: optionalString,
  agentId: optionalString,
  branch: optionalString,
  path: optionalString,
  relevanceFloor: numberRange(0, 1).optional(),
  types: z.array(z.enum(["semantic", "episodic", "procedural"])).optional(),
})

const MemoryStoreParams = z.object({
  text: requiredString("required"),
  scope: z.enum(["global", "workspace", "character", "agent"]).optional(),
  characterId: optionalString,
  projectId: optionalString,
  agentId: optionalString,
  branch: optionalString,
  pathPattern: optionalString,
  type: z.enum(["semantic", "episodic", "procedural"]).optional(),
  key: optionalString,
  importance: numberRange(1, 10).optional(),
  provenance: z.enum(["explicit", "system"]).optional(),
  piiGate: z.enum(["block", "redact"]).optional(),
})

const TeamCreateParams = z.object({
  name: requiredString("required"),
  description: optionalString,
  orchestration: z.enum(["round_robin", "supervisor", "mention_round_robin"]).optional(),
  supervisorCharacterId: optionalString,
  membersJson: optionalString,
  members: z.array(z.unknown()).optional(),
})

const TeamUpdateParams = z.object({
  teamId: requiredString("required"),
  patchJson: optionalString,
  patch: z.record(z.string(), z.unknown()).optional(),
})

// action.team.compose — auto-orchestrate a team from a single objective
// (planAutoOrchestration → materializeProposal). `autoStart` optionally kicks
// off the lifecycle immediately after materialization.
const TeamComposeParams = z.object({
  objective: requiredString("required"),
  name: optionalString,
  maxRoster: numberRange(1, 16).optional(),
  preferredPattern: z
    .enum([
      "manager_worker",
      "parallel_specialists",
      "background_handoff",
      "external_handoff",
      "single_agent_recommended",
      "ultracode_orchestration",
    ])
    .optional(),
  autoStart: z.boolean().optional(),
  ultracode: z.boolean().optional(),
})

// action.team.status — read-only snapshot of an agent team (status,
// finalResult, tasks/teammates/delegations on demand).
const TeamStatusParams = z.object({
  teamId: requiredString("required"),
  includeTasks: z.boolean().optional(),
  includeTeammates: z.boolean().optional(),
  includeDelegations: z.boolean().optional(),
})

// action.team.delegate — hand a sub-problem to another agent system on
// behalf of a team. Target-specific requirements (twinId / targetTeamId /
// targetAgentId / prompt) are enforced at runtime in the executor because
// they depend on `target`.
const TeamDelegateParams = z.object({
  teamId: requiredString("required"),
  target: z.enum(["twin", "background", "external", "team"]),
  taskId: optionalString,
  prompt: optionalString,
  systemPrompt: optionalString,
  reason: optionalString,
  twinId: optionalString,
  targetTeamId: optionalString,
  targetAgentId: optionalString,
  awaitCompletion: z.boolean().optional(),
  force: z.boolean().optional(),
  ultracode: z.boolean().optional(),
})

// action.team.message — post into the team blackboard / chat.
const TeamMessageParams = z.object({
  teamId: requiredString("required"),
  content: requiredString("required"),
  senderId: optionalString,
  recipientId: optionalString,
  taskId: optionalString,
})

// Synthesizer-emitted dispatch node. `requiredString` MUST be called — passing
// the bare function reference made every field validate as a Zod function type
// instead of a non-empty string, silently disabling validation here.
const TeamTaskDispatchParams = z.object({
  teamId: requiredString("required"),
  taskId: requiredString("required"),
  title: requiredString("required"),
  description: requiredString("required"),
  expectedOutput: optionalString,
  assignedTo: optionalString,
  dependencies: z.array(z.string()).optional(),
})

// Synthesizer-emitted review node (ADR-0071): one per task when
// `taskReview.enabled`. `dispatchNodeId` is how the executor finds the worker's
// output + author on `ctx.upstream`; `maxRevisions` is baked in at synthesis so
// a mid-run config edit cannot change a budget the DAG was already shaped by.
const TeamTaskReviewParams = z.object({
  teamId: requiredString("required"),
  taskId: requiredString("required"),
  title: requiredString("required"),
  description: requiredString("required"),
  expectedOutput: optionalString,
  dispatchNodeId: requiredString("required"),
  maxRevisions: z.number().int().min(0),
})

// action.team.reconcile — all optional; unset fields fall back to the team's
// workspaceIsolation config. Only meaningful inside a workspace-isolated run.
const TeamReconcileParams = z.object({
  mode: z.enum(["manual", "merge-all", "select", "pipeline"]).optional(),
  selectStrategy: z.enum(["manual", "first-success", "judge"]).optional(),
  retain: z.enum(["all", "keep-winner", "prune-losers"]).optional(),
})

const PlanStepKind = z.enum([
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
  "editor_review",
])

const PlanStepStatus = z.enum([
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
])

const PlanSource = z.enum([
  "exit_plan_mode",
  "agent_tool",
  "planner_llm",
  "team_projection",
  "goal_projection",
  "manual",
])

const PlanExecutionMode = z.enum(["in_session", "orchestrated", "auto"])
const PlanRefinementType = z.enum(["optimize", "simplify", "expand", "reorder", "repair"])
const PlanRefinementTrigger = z.enum(["manual", "step_failure", "judge_deviation"])
const PlanStatus = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
  "completed",
  "failed",
  "cancelled",
])

const PlanCreateStepInputParams = z.object({
  title: requiredString("required"),
  description: optionalString,
  kind: PlanStepKind,
  dependsOn: z.array(z.number().int().min(0)).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  estimatedDurationMs: numberRange(0).optional(),
})

const PlanCreateParams = z
  .object({
    sessionId: requiredString("required"),
    characterId: optionalString,
    title: requiredString("required"),
    description: optionalString,
    source: PlanSource.optional(),
    executionMode: PlanExecutionMode.optional(),
    stepsJson: optionalString,
    steps: z.array(PlanCreateStepInputParams).min(1).optional(),
    configJson: optionalString,
    config: z.record(z.string(), z.unknown()).optional(),
    metadataJson: optionalString,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) =>
      (typeof v.stepsJson === "string" && v.stepsJson.trim() !== "") ||
      (Array.isArray(v.steps) && v.steps.length > 0),
    { message: "required", path: ["stepsJson"] }
  )

const PlanIdParams = z.object({
  planId: requiredString("required"),
})

const PlanListParams = z
  .object({
    mode: z.enum(["all", "session", "openForSession", "executingForSession"]).optional(),
    sessionId: optionalString,
    status: z.union([PlanStatus, z.literal("")]).optional(),
    projectId: optionalString,
    limit: numberRange(1, 1000).optional(),
  })
  .refine(
    (v) => {
      const mode = v.mode ?? "all"
      return mode === "all" || (typeof v.sessionId === "string" && v.sessionId.length > 0)
    },
    { message: "required", path: ["sessionId"] }
  )

const PlanEventsParams = PlanIdParams.extend({
  limit: numberRange(1, 5000).optional(),
})

const PlanUpdateDraftParams = PlanIdParams.extend({
  title: optionalString,
  description: optionalString,
  executionMode: PlanExecutionMode.optional(),
  stepsJson: optionalString,
  steps: z.array(z.unknown()).optional(),
  configJson: optionalString,
  config: z.record(z.string(), z.unknown()).optional(),
  metadataJson: optionalString,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (v) =>
    [v.title, v.description, v.executionMode, v.stepsJson, v.configJson, v.metadataJson].some(
      (value) => typeof value === "string" && value.trim() !== ""
    ) ||
    v.steps !== undefined ||
    v.config !== undefined ||
    v.metadata !== undefined,
  { message: "required", path: ["title"] }
)

const PlanRejectParams = PlanIdParams.extend({
  feedback: optionalString,
})

const PlanRefineParams = PlanIdParams.extend({
  refinementType: PlanRefinementType.optional(),
  trigger: PlanRefinementTrigger.optional(),
  failedStepId: optionalString,
  customInstructions: optionalString,
})

const PlanSetStepStatusParams = PlanIdParams.extend({
  stepId: requiredString("required"),
  status: PlanStepStatus,
  result: optionalString,
  error: optionalString,
  outputJson: optionalString,
  output: z.unknown().optional(),
  attempts: numberRange(0).optional(),
})

const SchedulerTaskType = z.enum([
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

const SchedulerTaskStatus = z.enum(["active", "paused", "disabled", "expired"])
const SchedulerTaskTriggerType = z.enum(["cron", "interval", "once", "event"])
const SchedulerStringArray = z.array(z.string()).optional()

const SchedulerTaskIdParams = z.object({
  taskId: requiredString("required"),
})

const SchedulerTaskCreateParams = z
  .object({
    name: requiredString("required"),
    description: optionalString,
    type: SchedulerTaskType,
    triggerType: SchedulerTaskTriggerType,
    cronExpression: optionalString,
    intervalMs: numberRange(1).optional(),
    runAt: optionalString,
    eventType: optionalString,
    eventSource: optionalString,
    timezone: optionalString,
    jitterMs: numberRange(0).optional(),
    dependsOn: SchedulerStringArray,
    dependsOnRaw: optionalString,
    payload: z.record(z.string(), z.unknown()).optional(),
    payloadJson: optionalString,
    config: z.record(z.string(), z.unknown()).optional(),
    configJson: optionalString,
    notification: z.record(z.string(), z.unknown()).optional(),
    notificationJson: optionalString,
    tags: SchedulerStringArray,
    tagsRaw: optionalString,
    endAt: optionalString,
    onSuccessTaskIds: SchedulerStringArray,
    onSuccessTaskIdsRaw: optionalString,
    onFailureTaskIds: SchedulerStringArray,
    onFailureTaskIdsRaw: optionalString,
  })
  .refine(
    (v) =>
      v.triggerType !== "cron" ||
      (typeof v.cronExpression === "string" && cronExprRegex.test(v.cronExpression)),
    { message: "cronExpr", path: ["cronExpression"] }
  )
  .refine((v) => v.triggerType !== "interval" || typeof v.intervalMs === "number", {
    message: "required",
    path: ["intervalMs"],
  })
  .refine((v) => v.triggerType !== "once" || Boolean(v.runAt?.trim()), {
    message: "required",
    path: ["runAt"],
  })
  .refine((v) => v.triggerType !== "event" || Boolean(v.eventType?.trim()), {
    message: "required",
    path: ["eventType"],
  })

const SchedulerTaskListParams = z.object({
  statuses: z.array(SchedulerTaskStatus).optional(),
  statusesRaw: optionalString,
  types: z.array(SchedulerTaskType).optional(),
  typesRaw: optionalString,
  tags: SchedulerStringArray,
  tagsRaw: optionalString,
  search: optionalString,
  limit: numberRange(1, 1000).optional(),
})

const SchedulerTaskUpdateParams = SchedulerTaskIdParams.extend({
  name: optionalString,
  description: optionalString,
  status: SchedulerTaskStatus.optional(),
  triggerType: SchedulerTaskTriggerType.optional(),
  cronExpression: optionalString,
  intervalMs: numberRange(1).optional(),
  runAt: optionalString,
  eventType: optionalString,
  eventSource: optionalString,
  timezone: optionalString,
  jitterMs: numberRange(0).optional(),
  dependsOn: SchedulerStringArray,
  dependsOnRaw: optionalString,
  payload: z.record(z.string(), z.unknown()).optional(),
  payloadJson: optionalString,
  config: z.record(z.string(), z.unknown()).optional(),
  configJson: optionalString,
  notification: z.record(z.string(), z.unknown()).optional(),
  notificationJson: optionalString,
  tags: SchedulerStringArray,
  tagsRaw: optionalString,
  endAt: optionalString,
  clearEndAt: z.boolean().optional(),
  onSuccessTaskIds: SchedulerStringArray,
  onSuccessTaskIdsRaw: optionalString,
  onFailureTaskIds: SchedulerStringArray,
  onFailureTaskIdsRaw: optionalString,
}).refine(
  (v) =>
    [
      v.name,
      v.description,
      v.status,
      v.triggerType,
      v.cronExpression,
      v.runAt,
      v.eventType,
      v.eventSource,
      v.timezone,
      v.dependsOnRaw,
      v.payloadJson,
      v.configJson,
      v.notificationJson,
      v.tagsRaw,
      v.endAt,
      v.onSuccessTaskIdsRaw,
      v.onFailureTaskIdsRaw,
    ].some((value) => (typeof value === "string" ? value.trim() !== "" : value !== undefined)) ||
    v.intervalMs !== undefined ||
    v.jitterMs !== undefined ||
    v.clearEndAt === true ||
    v.dependsOn !== undefined ||
    v.payload !== undefined ||
    v.config !== undefined ||
    v.notification !== undefined ||
    v.tags !== undefined ||
    v.onSuccessTaskIds !== undefined ||
    v.onFailureTaskIds !== undefined,
  { message: "required", path: ["name"] }
)

const SchedulerTaskExecutionsParams = SchedulerTaskIdParams.extend({
  limit: numberRange(1, 5000).optional(),
})

const SchedulerTaskBackfillParams = SchedulerTaskIdParams.extend({
  start: requiredString("required"),
  end: requiredString("required"),
})

const SchedulerTaskExportParams = z.object({
  taskIds: SchedulerStringArray,
  taskIdsRaw: optionalString,
})

const SchedulerTaskImportParams = z.object({
  dataJson: requiredString("required"),
  mode: z.enum(["merge", "replace"]).optional(),
})

const SchedulerLimitParams = z.object({
  limit: numberRange(1, 1000).optional(),
})

const SchedulerExecutionGetParams = z.object({
  executionId: requiredString("required"),
})

const SchedulerEventTriggerParams = z.object({
  eventType: requiredString("required"),
  eventSource: optionalString,
  payload: z.record(z.string(), z.unknown()).optional(),
  payloadJson: optionalString,
})

// Synthesizer-emitted plan step node (ADR-0045). Not user-editable; params are
// stamped by `synthesizePlanWorkflow`. `stepKind` is informational for the
// editor; the executor reads the full step from the PlanRunContext snapshot.
const PlanStepDispatchParams = z.object({
  planId: requiredString("required"),
  stepId: requiredString("required"),
  title: optionalString,
  stepKind: optionalString,
})

const SkillInvokeParams = z.object({
  skillIds: requiredString("required"),
})

const SkillUpsertParams = z.object({
  skillId: optionalString,
  name: requiredString("required"),
  description: optionalString,
  content: requiredString("required"),
  tagsRaw: optionalString,
  tags: z.array(z.string()).optional(),
})

// ── Actions: twins / connectors / extensibility ─────────────────────────────

const TwinRagParams = z.object({
  twinId: requiredString("required"),
  query: requiredString("required"),
  topK: numberRange(1, 50).optional(),
})

const TwinIngestParams = z
  .object({
    twinId: requiredString("required"),
    sourceMode: z.enum(["paste", "fetch"]).optional(),
    format: z.enum(["markdown", "text", "code", "chat"]).optional(),
    content: optionalString,
    url: z.string().refine(isHttpUrlOrExpression, "invalidUrl").optional(),
    title: optionalString,
  })
  .refine(
    (v) => {
      const mode = v.sourceMode ?? "paste"
      if (mode === "fetch") return typeof v.url === "string" && v.url.length > 0
      return typeof v.content === "string" && v.content.length > 0
    },
    { message: "twinIngestSourceRequired", path: ["content"] }
  )

const KnowledgeSourceParams = z
  .object({
    knowledgeBaseId: requiredString("required"),
    sourceMode: z.enum(["text", "web", "existing"]),
    sourceId: optionalString,
    sourceKey: optionalString,
    title: optionalString,
    format: optionalString,
    content: optionalString,
    url: z.string().refine(isHttpUrlOrExpression, "invalidUrl").optional(),
  })
  .superRefine((value, context) => {
    if (value.sourceMode === "existing" && !value.sourceId?.trim()) {
      context.addIssue({ code: "custom", message: "required", path: ["sourceId"] })
    }
    if (value.sourceMode === "text" && !value.content?.trim()) {
      context.addIssue({ code: "custom", message: "required", path: ["content"] })
    }
    if (value.sourceMode === "web" && !value.url?.trim()) {
      context.addIssue({ code: "custom", message: "required", path: ["url"] })
    }
  })

const KnowledgeArtifactParams = z.object({ artifactId: requiredString("required") })
const KnowledgeParseParams = z.object({ sourceId: requiredString("required") })
const KnowledgeRetrieveParams = z.object({
  knowledgeBaseIds: z.array(requiredString("required")).min(1).max(32),
  query: requiredString("required"),
  topKPerBase: numberRange(1, 50).optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
  tokenBudget: numberRange(1, 100_000).optional(),
  revisionBindings: z
    .record(
      z.string(),
      z.union([requiredString("required"), z.array(requiredString("required")).min(1)])
    )
    .optional(),
})

const ConnectorSendParams = z.object({
  adapterId: requiredString("required"),
  conversationKey: requiredString("required"),
  content: requiredString("required"),
  piiGate: z.enum(["block", "redact"]).optional(),
  /**
   * Optional A2UI surface JSON (`{components, dataModel, rootId, …}`).
   * When set, the node sends an interactive card (projected per-platform by
   * the a2ui-bridge — Lark interactive card, etc.) with `content` as the
   * plain-text mirror for capability fallback. Must parse as JSON with
   * `components` + `rootId`; validated at execution.
   */
  cardJson: optionalString,
  /** Reply anchor — platforms that support replies quote this message. */
  replyToMessageId: optionalString,
  /** Thread anchor — posts into the thread instead of the main channel. */
  threadId: optionalString,
  /** Explicit dedup key; defaults to `${runId}:${stepId}` at execution. */
  idempotencyKey: optionalString,
  /**
   * Edit-in-place: when set, the outbound runner routes to `adapter.edit()`
   * on this platform message id instead of sending a new message (platforms
   * without edit support fall back to a plain send, audited).
   */
  editTargetMessageId: optionalString,
  /**
   * Delivery feedback: block until the queued job reaches a terminal state
   * (`sent` / `deadlettered`) — or `waitTimeoutMs` elapses — and surface
   * `status` / `platformMessageId` / `errorCode` on the node output.
   * Default false: enqueue-and-continue (previous behaviour).
   */
  waitForDelivery: z.boolean().optional(),
  /** Wait budget for `waitForDelivery`, ms (default 30 000, max 5 min). */
  waitTimeoutMs: numberRange(100, 300_000).optional(),
})

const ConnectorDraftParams = z.object({
  conversationKey: requiredString("required"),
  sessionId: requiredString("required"),
  content: requiredString("required"),
  sourceMessageId: optionalString,
  ttlMs: numberRange(0).optional(),
})

const ConnectorReactionParams = z.object({
  adapterId: requiredString("required"),
  /** Platform message id to react to (e.g. Lark `om_…`). */
  messageId: requiredString("required"),
  /** Platform emoji code (Lark reaction type like "THUMBSUP", or a unicode emoji). */
  emoji: requiredString("required"),
  /** Operation: add a reaction (default) or remove one by `reactionId`. */
  op: z.enum(["add", "remove"]).optional(),
  /**
   * Platform reaction id — REQUIRED when `op="remove"` (from a prior add
   * node's `reactionId` output). Ignored for `op="add"`.
   */
  reactionId: optionalString,
})

const ConnectorDeleteParams = z.object({
  adapterId: requiredString("required"),
  /** Platform message id to recall/delete. */
  messageId: requiredString("required"),
})

const ConnectorForwardParams = z.object({
  adapterId: requiredString("required"),
  /** Single message id to forward. Use EITHER this or `messageIds`. */
  messageId: optionalString,
  /** Two or more message ids to merge-forward as one combined card. */
  messageIds: z.array(z.string()).optional(),
  /**
   * Destination conversation key (`platform:adapterId:chatId`) or a raw
   * platform receive id (Lark chat_id / open_id).
   */
  targetConversationKey: requiredString("required"),
  piiGate: z.enum(["block", "redact"]).optional(),
})

const ConnectorWaitReplyParams = z.object({
  /** Conversation to listen on (composite key `platform:adapterId:chatId[:thread]`). */
  conversationKey: requiredString("required"),
  /** Only accept replies from these platform user ids (any when empty). */
  senderIds: z.array(z.string()).optional(),
  /** Case-insensitive substrings; any match accepts the reply. */
  keywords: z.array(z.string()).optional(),
  /** Only accept replies that @-mention the bot. */
  requireMention: z.boolean().optional(),
  /** Wait budget in ms (default 120 000, max 1 h). */
  timeoutMs: numberRange(1_000, 3_600_000).optional(),
})

const ApprovalRequestParams = z.object({
  title: requiredString("required"),
  message: optionalString,
  /** How long to wait before the onTimeout policy applies. Default 1 h. */
  timeoutMs: numberRange(1_000).optional(),
  /** What a timeout means: route down "rejected" (default) or fail the step. */
  onTimeout: z.enum(["reject", "fail"]).optional(),
})

const HumanInputFieldOptionParams = z.object({
  value: requiredString("required"),
  label: requiredString("required"),
})

const HumanInputFieldParams = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    type: z.enum([
      "short-text",
      "long-text",
      "number",
      "boolean",
      "single-select",
      "multi-select",
      "file",
      "file-list",
    ]),
    label: requiredString("required"),
    description: optionalString,
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    options: z.array(HumanInputFieldOptionParams).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    accept: z.array(z.string().trim().min(1)).optional(),
    maxFiles: numberRange(1, 100).optional(),
  })
  .superRefine((field, ctx) => {
    if (
      (field.type === "single-select" || field.type === "multi-select") &&
      (!field.options || field.options.length === 0)
    ) {
      ctx.addIssue({ code: "custom", message: "optionsRequired", path: ["options"] })
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: "custom", message: "invalidRange", path: ["max"] })
    }
  })

const HumanInputActionParams = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  label: requiredString("required"),
  tone: z.enum(["primary", "secondary", "destructive"]).optional(),
})

const HumanInputAssigneeParams = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initiator") }),
  z.object({ kind: z.literal("member"), id: requiredString("required") }),
  z.object({ kind: z.literal("group"), id: requiredString("required") }),
])

const HumanInputRequestParams = z
  .object({
    title: requiredString("required"),
    message: optionalString,
    // Action-only forms are valid (for example, an acknowledge/reject gate).
    // Dify 1.16.1 also persists Human Input nodes with an empty inputs list.
    fields: z.array(HumanInputFieldParams),
    actions: z.array(HumanInputActionParams).min(1),
    assignees: z.array(HumanInputAssigneeParams).min(1),
    completionPolicy: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("any") }),
      z.object({ mode: z.literal("all") }),
      z.object({ mode: z.literal("quorum"), count: numberRange(1, 10_000) }),
    ]),
    /** Default 3 days; authored range is one minute through thirty days. */
    timeoutMs: numberRange(60_000, 30 * 24 * 60 * 60 * 1000).optional(),
    /** Encrypted sensitive values can be destroyed earlier than request metadata. */
    sensitiveRetentionDays: numberRange(1, 30).optional(),
  })
  .superRefine((params, ctx) => {
    const fieldIds = params.fields.map((field) => field.id)
    if (new Set(fieldIds).size !== fieldIds.length) {
      ctx.addIssue({ code: "custom", message: "duplicateFieldId", path: ["fields"] })
    }
    const actionIds = params.actions.map((action) => action.id)
    if (new Set(actionIds).size !== actionIds.length || actionIds.includes("timeout")) {
      ctx.addIssue({ code: "custom", message: "invalidActionId", path: ["actions"] })
    }
    if (
      params.completionPolicy.mode === "quorum" &&
      params.completionPolicy.count > params.assignees.length
    ) {
      ctx.addIssue({ code: "custom", message: "quorumTooLarge", path: ["completionPolicy"] })
    }
  })

/** Shared remote-device fields (ADR 0061 P3): pin a device, bound the wait. */
const mobileStepBase = {
  /** Pin to one paired device; empty = any capable device (freshest first). */
  deviceId: optionalString,
  /** How long to wait for the device. Default 120 s. */
  timeoutMs: numberRange(1_000).optional(),
}

const MobileCameraParams = z.object({
  ...mobileStepBase,
  quality: numberRange(1, 100).optional(),
  width: numberRange(64).optional(),
})

const MobileScanBarcodeParams = z.object({
  ...mobileStepBase,
  formats: z.array(z.string()).optional(),
})

const MobileLocationParams = z.object({
  ...mobileStepBase,
  enableHighAccuracy: z.boolean().optional(),
})

const MobileShareParams = z
  .object({
    ...mobileStepBase,
    title: optionalString,
    text: optionalString,
    url: optionalString,
  })
  .refine((v) => Boolean(v.text?.length) || Boolean(v.url?.length), {
    message: "required",
    path: ["text"],
  })

const MobileNotifyParams = z.object({
  ...mobileStepBase,
  title: requiredString("required"),
  body: optionalString,
})

const McpInvokeToolParams = z.object({
  serverId: requiredString("required"),
  toolName: requiredString("required"),
  argsJson: optionalString,
  args: z.unknown().optional(),
  piiGate: z.enum(["block", "redact"]).optional(),
})

// `taskId` is optional at this layer because tool-mode nodes don't carry
// one — the executor enforces the per-mode requirement (`toolName` for
// "tool", `taskId` for "task") with a non-retryable error, and the
// inspector form provides richer client-side validation.
const PluginInvokeParams = z.object({
  pluginId: requiredString("required"),
  mode: z.enum(["task", "tool"]).optional(),
  toolName: optionalString,
  taskId: optionalString,
  argsJson: optionalString,
  args: z.unknown().optional(),
  piiGate: z.enum(["block", "redact"]).optional(),
})

// ── Desktop automation ──────────────────────────────────────────────────────

const DesktopElementRef = z.union([requiredString("required"), z.array(z.string()).min(1)])
const DesktopPoint = z.object({
  x: z.number(),
  y: z.number(),
})
const DesktopLocatorParams = z.object({
  name: optionalString,
  nameContains: optionalString,
  automationId: optionalString,
  controlType: optionalString,
  className: optionalString,
  processId: positiveInteger().optional(),
  processName: optionalString,
  windowTitleContains: optionalString,
  depth: numberRange(0).optional(),
})
const DesktopAppLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bundleId"), bundleId: requiredString("required") }),
  z.object({ kind: z.literal("path"), path: requiredString("required") }),
  z.object({ kind: z.literal("displayName"), displayName: requiredString("required") }),
])
const DesktopElementHandle = z.object({
  sessionId: requiredString("required"),
  lineageId: requiredString("required"),
  revision: positiveInteger(),
  index: numberRange(0),
  fingerprint: requiredString("required"),
})
const DesktopPixelTarget = z.object({
  sessionId: requiredString("required"),
  lineageId: requiredString("required"),
  revision: positiveInteger(),
  point: DesktopPoint,
  screenshotWidth: positiveInteger(),
  screenshotHeight: positiveInteger(),
})
const DesktopActionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element"), handle: DesktopElementHandle }),
  z.object({ kind: z.literal("pixel"), target: DesktopPixelTarget }),
])
const DesktopUiAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    button: z.enum(["left", "right", "middle"]).optional(),
    count: numberRange(1, 3).optional(),
  }),
  z.object({
    kind: z.literal("drag"),
    to: DesktopPoint,
    opts: z
      .object({
        button: z.enum(["left", "right", "middle"]).optional(),
        durationMs: numberRange(0).optional(),
        steps: numberRange(1).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    opts: z
      .object({
        dx: z.number().optional(),
        dy: z.number().optional(),
        amount: z.number().optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal("pressKey"), chord: z.array(z.string()).length(1) }),
  z.object({ kind: z.literal("typeText"), text: z.string() }),
  z.object({ kind: z.literal("setValue"), value: z.string() }),
  z.object({
    kind: z.literal("selectText"),
    start: numberRange(0),
    end: numberRange(0),
  }),
  z.object({ kind: z.literal("secondaryAction"), name: requiredString("required") }),
])

const DesktopListAppsParams = z.object({})
const DesktopGetAppStateParams = z.object({
  sessionId: optionalString,
  locator: DesktopAppLocator,
  options: z
    .object({
      disableDiff: z.boolean().optional(),
      allowLaunch: z.boolean().optional(),
      maxNodes: numberRange(1, 1000).optional(),
      maxDepth: numberRange(1, 64).optional(),
      projection: z.literal("model").optional(),
    })
    .optional(),
})
const DesktopQueryElementsParams = z.object({
  sessionId: requiredString("required"),
  lineageId: requiredString("required"),
  revision: positiveInteger(),
  locator: DesktopLocatorParams.optional(),
  limit: numberRange(1, 1000).optional(),
})
const DesktopExpandElementParams = z.object({
  handle: DesktopElementHandle,
  continuationToken: z.string().nullable().optional(),
  limit: numberRange(1, 250).optional(),
})
const DesktopPerformActionParams = z.object({
  request: z.object({
    turnToken: requiredString("required"),
    target: DesktopActionTarget,
    action: DesktopUiAction,
    strategy: z.enum(["semantic", "pixel", "auto"]),
  }),
})

const DesktopEventKind = z.enum([
  "focus-changed",
  "structure-changed",
  "property-changed",
  "text-selection-changed",
])
const DesktopEventTriggerParams = z.object({
  kinds: z.array(DesktopEventKind).optional(),
  scope: DesktopElementRef.optional(),
  /**
   * Loop guard: minimum ms between fires per workflow (a workflow's own
   * desktop actions cause focus events). Default 2000.
   */
  cooldownMs: numberRange(0).optional(),
})

// ── AI primitives ──────────────────────────────────────────────────────────

// ai.prompt v2/provider additions, also accepted by the classify/extract delegators.
// All optional — v1 nodes validate against the same (superset) schema.
const aiProviderFields = {
  /** "routed" consults the provider-routing engine instead of explicit creds. */
  mode: z.enum(["explicit", "routed"]).optional(),
  /** Routed mode: model alias resolved through the mapping registry. */
  modelAlias: optionalString,
  /** Explicit mode: OpenAI endpoint family override for compatible providers. */
  apiFlavor: z.enum(["auto", "responses", "chat"]).optional(),
  /** Explicit mode: provider-specific static headers passed to the model factory. */
  headers: z.record(z.string(), z.string()).optional(),
  /** PII gate applied before any text egress. */
  piiGate: z.enum(["off", "block", "redact"]).optional(),
}

const AiPromptParams = z.object({
  ...aiProviderFields,
  provider: optionalString,
  model: optionalString,
  apiKey: optionalString,
  baseURL: optionalString,
  systemPrompt: optionalString,
  // Optional twin-bound character — injects the twin's retrieved context into
  // the system prompt when the character has a twinId (see ai-prompt-v2.ts).
  characterId: optionalString,
  userPrompt: requiredString("required"),
  temperature: numberRange(0, 2).optional(),
  // Structured output (B1): "json" parses the completion into output.structured.
  responseFormat: z.enum(["text", "json"]).optional(),
  jsonSchema: optionalString,
  // Typed output (D3): validated JSON object schema + auto-fix retry.
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  onSchemaViolation: z.enum(["fail", "soft"]).optional(),
})

const AiClassifyParams = z.object({
  ...aiProviderFields,
  provider: optionalString,
  model: optionalString,
  apiKey: optionalString,
  baseURL: optionalString,
  input: requiredString("required"),
  labelsRaw: requiredString("required"),
  labels: z.array(z.string()).optional(),
  hint: optionalString,
})

const AiExtractParams = z.object({
  ...aiProviderFields,
  provider: optionalString,
  model: optionalString,
  apiKey: optionalString,
  baseURL: optionalString,
  input: requiredString("required"),
  schemaJson: optionalString,
  schema: z.record(z.string(), z.unknown()).optional(),
  // Parameter Extractor (B4): names that must be present for output.valid.
  required: z.array(z.string()).optional(),
  hint: optionalString,
})

const AiEmbedParams = z.object({
  input: requiredString("required"),
  dimension: numberRange(32, 4096).optional(),
  // Real semantic embedding (B3): when provider+model set, use the real
  // embedder; otherwise fall back to the deterministic hash.
  provider: optionalString,
  model: optionalString,
  apiKey: optionalString,
})

const BrowserModelParams = z
  .object({
    operation: z.enum(["infer", "preload", "status", "disposeModel", "disposeAll"]),
    task: z
      .enum([
        "automatic-speech-recognition",
        "depth-estimation",
        "feature-extraction",
        "fill-mask",
        "image-classification",
        "image-segmentation",
        "image-to-text",
        "object-detection",
        "question-answering",
        "sentence-similarity",
        "summarization",
        "text-classification",
        "text-generation",
        "text-to-speech",
        "text2text-generation",
        "token-classification",
        "translation",
        "zero-shot-classification",
      ])
      .optional(),
    modelId: optionalString,
    input: optionalString,
    inputJson: optionalString,
    device: z.enum(["wasm", "webgpu"]).optional(),
    dtype: z.enum(["fp32", "fp16", "q8", "q4"]).optional(),
    cacheEnabled: z.boolean().optional(),
    maxCachedModels: numberRange(1, 8).optional(),
    timeoutMs: numberRange(1_000, 600_000).optional(),
    topK: numberRange(1, 100).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxNewTokens: numberRange(1, 8_192).optional(),
    maxLength: numberRange(1, 32_768).optional(),
    language: optionalString,
    returnTimestamps: z.union([z.boolean(), z.literal("word")]).optional(),
    candidateLabels: z.array(z.string().min(1)).optional(),
    hypothesisTemplate: optionalString,
  })
  .superRefine((params, context) => {
    if (params.operation === "status" || params.operation === "disposeAll") return
    if (!params.task) context.addIssue({ code: "custom", path: ["task"], message: "required" })
    if (!params.modelId) {
      context.addIssue({ code: "custom", path: ["modelId"], message: "required" })
    }
    if (params.operation === "infer" && !params.input && !params.inputJson) {
      context.addIssue({ code: "custom", path: ["input"], message: "required" })
    }
  })

// ai.council — multi-model consensus. Councillors + synthesizer are addressed
// by routing alias; the prompt fans out, then one synthesizer merges them.
const CouncillorSpecSchema = z.object({
  name: requiredString("required"),
  modelAlias: requiredString("required"),
  systemPrompt: optionalString,
})

const AiCouncilParams = z.object({
  prompt: requiredString("required"),
  councillors: z.array(CouncillorSpecSchema).min(1),
  synthesizerAlias: requiredString("required"),
  synthesisInstructions: optionalString,
  timeoutMs: numberRange(1000, 600000).optional(),
  executionMode: z.enum(["parallel", "serial"]).optional(),
  maxConcurrency: numberRange(1, 16).optional(),
  piiGate: z.enum(["off", "block", "redact"]).optional(),
})

const AiEnsembleAggregationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("majority-vote-on-field"), field: optionalString }),
  z.object({
    kind: z.literal("threshold-count"),
    field: optionalString,
    equals: z.unknown().optional(),
    threshold: numberRange(1),
  }),
  z.object({ kind: z.literal("best-of-by-score"), scoreField: requiredString("required") }),
  z.object({ kind: z.literal("synthesize-by-final-agent"), instructions: optionalString }),
])

const AiEnsembleParams = z.object({
  prompt: optionalString,
  target: z
    .object({
      kind: z.enum(["agent.turn", "subworkflow"]).optional(),
      systemPrompt: optionalString,
      model: optionalString,
      characterId: optionalString,
      allowedTools: z.array(z.string()).optional(),
      toolsEnabled: z.boolean().optional(),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
      workflowId: optionalString,
    })
    .optional(),
  n: numberRange(1, 50).optional(),
  iterationConcurrency: numberRange(1, 16).optional(),
  lens: z.array(z.string()).optional(),
  aggregation: AiEnsembleAggregationSchema.optional(),
  synthesizerAlias: optionalString,
  synthesisInstructions: optionalString,
  timeoutMs: numberRange(1000, 600000).optional(),
  piiGate: z.enum(["off", "block", "redact"]).optional(),
})

// ── Flow ────────────────────────────────────────────────────────────────────

// Structured condition language (typeVersion 2) — mirrors
// `types/workflow/conditions.ts`. Operand fields are expression strings.
const conditionOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
  "inRange",
  "isEmpty",
  "isNotEmpty",
  "truthy",
])

const conditionSchema = z.object({
  left: z.string(),
  operator: conditionOperatorSchema,
  right: optionalString,
  rightUpper: optionalString,
  caseSensitive: z.boolean().optional(),
})

const conditionGroupSchema = z.object({
  combinator: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema),
})

// Legacy (typeVersion 1) truthiness-expression shape.
const BranchParamsV1 = z.object({
  condition: requiredString("required"),
  truthyLabel: optionalString,
  falsyLabel: optionalString,
})

// typeVersion 2 — structured condition group routing to true/false handles.
const BranchParamsV2 = z.object({
  conditions: conditionGroupSchema,
})

// The schema map is keyed by kind only (no typeVersion), so accept both
// authoring generations. The inspector renders per-version forms; the
// validator just needs either shape to pass.
const BranchParams = z.union([BranchParamsV2, BranchParamsV1])

const SwitchParamsV1 = z.object({
  subject: requiredString("required"),
  cases: z.array(z.object({ value: z.unknown(), label: z.string() })).min(1, "switchCasesRequired"),
  defaultLabel: optionalString,
})

// typeVersion 2 — ordered cases, each with a stable id + condition group.
const SwitchParamsV2 = z.object({
  cases: z
    .array(
      z.object({
        id: optionalString,
        label: optionalString,
        when: conditionGroupSchema,
      })
    )
    .min(1, "switchCasesRequired"),
})

const SwitchParams = z.union([SwitchParamsV2, SwitchParamsV1])

const SplitParams = z.object({
  branchLabels: z.array(z.string()).min(2, "splitBranchesRequired"),
})

const JoinParams = z.object({
  joinPolicy: z.enum(["all", "any", "race"]).optional(),
  timeoutMs: numberRange(0).optional(),
  // Optional gather→reduce in one step (D6③); mirrors AggregateParams.
  aggregate: z
    .object({
      operation: z
        .enum(["collect", "concat", "merge-objects", "group-by", "dedupe", "numeric", "custom"])
        .optional(),
      keyExpression: optionalString,
      numericField: optionalString,
      numericOp: z.enum(["sum", "avg", "min", "max", "count"]).optional(),
      reducerExpression: optionalString,
      initialValue: z.unknown().optional(),
    })
    .optional(),
})

// Legacy (typeVersion 1) flat array-transform loop.
const LoopParamsV1 = z
  .object({
    mode: z.enum(["forEach", "times", "while"]).optional(),
    times: numberRange(0).optional(),
    inputExpression: optionalString,
    bodyExpression: requiredString("required"),
    whileCondition: optionalString,
    maxIterations: numberRange(1, 1_000_000).optional(),
  })
  .refine(
    (v) => {
      const mode = v.mode ?? "forEach"
      if (mode === "while")
        return typeof v.whileCondition === "string" && v.whileCondition.length > 0
      if (mode === "forEach")
        return typeof v.inputExpression === "string" && v.inputExpression.length > 0
      return typeof v.times === "number" && v.times > 0
    },
    {
      message: "loopBodyRequired",
      path: ["mode"],
    }
  )

// typeVersion 2 — container sub-canvas (types/workflow/visual.ts LoopNodeParams).
const LoopParamsV2 = z
  .object({
    mode: z.enum(["forEach", "times", "while"]),
    source: optionalString,
    times: z.union([numberRange(0), z.string()]).optional(),
    whileExpression: optionalString,
    conditionTiming: z.enum(["pre", "post"]).optional(),
    output: optionalString,
    iterationConcurrency: numberRange(1, 64).optional(),
    batchSize: numberRange(1, 100_000).optional(),
    maxIterations: numberRange(1, 100_000).optional(),
    onItemError: z
      .enum(["fail", "continue-with-null", "remove-failed", "break", "skip"])
      .optional(),
  })
  .refine(
    (v) => {
      if (v.mode === "forEach") return typeof v.source === "string" && v.source.length > 0
      if (v.mode === "while")
        return typeof v.whileExpression === "string" && v.whileExpression.length > 0
      return typeof v.times === "number"
        ? v.times > 0
        : typeof v.times === "string" && v.times.trim() !== ""
    },
    {
      message: "loopSourceRequired",
      path: ["mode"],
    }
  )
  .superRefine((v, ctx) => {
    // Mode-scoped knobs: reject silently-ignored configuration up front.
    if (v.conditionTiming !== undefined && v.mode !== "while") {
      ctx.addIssue({
        code: "custom",
        message: "loopConditionTimingMode",
        path: ["conditionTiming"],
      })
    }
    if (v.batchSize !== undefined && v.mode !== "forEach") {
      ctx.addIssue({
        code: "custom",
        message: "loopBatchSizeMode",
        path: ["batchSize"],
      })
    }
  })

// Schema lookup is keyed by kind only — accept both generations.
const LoopParams = z.union([LoopParamsV2, LoopParamsV1])

const WaitParams = z.object({
  mode: z.enum(["duration", "event"]).optional(),
  durationMs: numberRange(0).optional(),
  /**
   * Event mode: wake key an external source fires (`emitWake`). Empty means
   * the run-scoped default `${runId}:${stepId}` — private to this run.
   */
  eventKey: optionalString,
  /** Optional routing key when several runs wait on the same event name. */
  correlationId: optionalString,
  /** Event mode: give up after this long (0 / absent = wait until run abort). */
  timeoutMs: numberRange(0).optional(),
})

const SetVariableParams = z.object({
  variable: requiredString("required").regex(/^[a-z_][a-z0-9_]*$/i, "variableName"),
  // Expressions are resolved before validation, so a text expression can
  // legitimately become a number, boolean, object, array, or null. Reject
  // only an absent/unresolved value; the executor intentionally stores the
  // resolved value without coercing it back to a string.
  value: z.unknown().refine((value) => value !== undefined, "required"),
})

const SubworkflowParams = z.object({
  workflowId: requiredString("required"),
  inputJson: optionalString,
  input: z.unknown().optional(),
})

// ── System: integrated terminal ────────────────────────────────────────────
// Executor at `lib/workflow/nodes/terminal.ts` requires a non-empty command;
// the rest of the fields are optional and tolerated by `runTerminalDockAction`.
const SystemTerminalParams = z.object({
  command: requiredString("required"),
  args: z.array(z.string()).optional(),
  cwd: optionalString,
  shell: optionalString,
  projectId: optionalString,
  tabId: optionalString,
  timeoutSec: numberRange(0).optional(),
  onFailure: z.enum(["throw", "branch"]).optional(),
  // Unattended mode (headless, no consent) — gated by
  // settings.terminal.allowUnattendedExecution + classifyCommand.
  unattended: z.boolean().optional(),
  onAskVerdict: z.enum(["fail", "consent", "run"]).optional(),
})

// ── Terminal: persistent sessions ───────────────────────────────────────────
// Executors at `lib/workflow/nodes/terminal/session.ts`.
const TerminalSessionOpenParams = z.object({
  cwd: optionalString,
  shell: optionalString,
  projectId: optionalString,
  unattended: z.boolean().optional(),
})

const TerminalSessionRunParams = z.object({
  sessionId: requiredString("required"),
  command: requiredString("required"),
  args: z.array(z.string()).optional(),
  timeoutSec: numberRange(0).optional(),
  onFailure: z.enum(["throw", "branch"]).optional(),
  onAskVerdict: z.enum(["fail", "consent", "run"]).optional(),
})

const TerminalSessionCloseParams = z.object({
  sessionId: requiredString("required"),
})

// Run a script file under its detected (or overridden) interpreter.
// Executor at `lib/workflow/nodes/terminal/script.ts`.
const TerminalScriptParams = z.object({
  scriptPath: requiredString("required"),
  interpreter: optionalString,
  args: z.array(z.string()).optional(),
  cwd: optionalString,
  projectId: optionalString,
  timeoutSec: numberRange(0).optional(),
  onFailure: z.enum(["throw", "branch"]).optional(),
  unattended: z.boolean().optional(),
  onAskVerdict: z.enum(["fail", "consent", "run"]).optional(),
})

// Dock-parity nodes (read_recent / wait_for_exit) — executors in
// `lib/workflow/nodes/terminal.ts`, delegating to `runTerminalDockAction`.
const TerminalReadRecentParams = z.object({
  tabId: requiredString("required"),
  lineLimit: numberRange(1, 50).optional(),
})

const TerminalWaitForExitParams = z.object({
  tabId: requiredString("required"),
  timeoutSec: numberRange(0).optional(),
  onFailure: z.enum(["throw", "branch"]).optional(),
})

// All optional — an unscoped node fires for every command that ends in a
// user-spawned dock tab. Scope by session, project, exit status, or a
// command substring. Empty string = match any (mirrors the goal trigger).
const TerminalCommandTriggerParams = z.object({
  sessionId: optionalString,
  projectId: optionalString,
  status: z.enum(["success", "failure"]).or(z.literal("")).optional(),
  commandContains: optionalString,
})

// ── Data ────────────────────────────────────────────────────────────────────

const TransformParams = z.object({
  operation: z.enum(["map", "filter", "reduce", "sort", "flatten"]).optional(),
  expression: requiredString("required"),
})

const AggregateParams = z.object({
  operation: z
    .enum(["collect", "concat", "merge-objects", "group-by", "dedupe", "numeric", "custom"])
    .optional(),
  keyExpression: optionalString,
  numericField: optionalString,
  numericOp: z.enum(["sum", "avg", "min", "max", "count"]).optional(),
  reducerExpression: optionalString,
  initialValue: z.unknown().optional(),
})

const CodeParams = z.object({
  code: requiredString("required"),
})

const TemplateParams = z.object({
  template: requiredString("required"),
})

// ── IO ──────────────────────────────────────────────────────────────────────

const HttpRequestParams = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: requiredString("required").refine(isHttpUrlOrExpression, "invalidUrl"),
  body: optionalString,
  followRedirects: z.boolean().optional(),
  piiGate: z.enum(["block", "redact"]).optional(),
})

const WebCloneParams = z.object({
  url: requiredString("required").refine(isHttpUrlOrExpression, "invalidUrl"),
  output: requiredString("required"),
  mode: z.enum(["single", "bundle"]).optional(),
  extractComponents: z.boolean().optional(),
  framework: z.enum(["vue", "react", "angular", "svelte", "jquery"]).optional(),
  frameworkHint: z.enum(["vue", "react", "svelte"]).optional(),
  maxAssets: numberRange(1, 5000).optional(),
  concurrency: numberRange(1, 32).optional(),
  timeout: numberRange(1000, 120000).optional(),
  maxFileSize: numberRange(0, 1024 * 1024 * 1024).optional(),
  pretty: z.boolean().optional(),
  allowPrivateHosts: z.boolean().optional(),
  codegenGenerateDrafts: z.boolean().optional(),
  codegenExtractShared: z.boolean().optional(),
})

const WebhookRespondParams = z.object({
  status: numberRange(100, 599).optional(),
  headersJson: optionalString,
  headers: z.record(z.string(), z.unknown()).optional(),
  body: optionalString,
})

const OutputParams = z.object({
  // The terminal value (expression or literal); falls back to the first upstream.
  value: z.unknown().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  onSchemaViolation: z.enum(["fail", "soft"]).optional(),
})

const AnswerParams = z
  .object({
    text: z.string().optional(),
    content: z.unknown().optional(),
    citations: z
      .array(
        z.object({
          sourceId: requiredString("required"),
          documentId: requiredString("required"),
          revisionId: requiredString("required"),
          chunkId: requiredString("required"),
          label: optionalString,
          location: optionalString,
          previewUrl: optionalString,
        })
      )
      .optional(),
    files: z
      .array(
        z.object({
          ref: requiredString("required"),
          name: optionalString,
          mediaType: optionalString,
        })
      )
      .optional(),
    suggestions: z.array(z.string()).optional(),
  })
  .refine((value) => value.text !== undefined || value.content !== undefined, {
    message: "text or content is required",
  })

const CatchParams = z.object({
  /**
   * Recovery scope. "workflow" (default): runs on ANY terminal run failure.
   * "upstream": only when a directly-upstream node is the failure origin
   * (reserved; treated as "workflow" until upstream wiring lands).
   */
  scope: z.enum(["workflow", "upstream"]).optional(),
})

// ── Annotations ────────────────────────────────────────────────────────────

const NoteParams = z.object({
  text: optionalString,
  color: z.enum(["yellow", "green", "blue", "pink", "violet"]).optional(),
})

const GroupAnnotationParams = z.object({
  title: optionalString,
  color: optionalString,
  width: numberRange(200).optional(),
  height: numberRange(100).optional(),
})

// ── Registry ───────────────────────────────────────────────────────────────

export const PARAMS_SCHEMAS = {
  // Triggers
  "trigger.manual": ManualTriggerParams,
  "trigger.cron": CronParams,
  "trigger.connector.inbound": ConnectorInboundParams,
  "trigger.connector.system": ConnectorSystemTriggerParams,
  "trigger.chat.message": ChatMessageTriggerParams,
  "trigger.goal.completed": GoalCompletedTriggerParams,
  "trigger.workflow.completed": WorkflowCompletedTriggerParams,
  "trigger.pet.event": PetEventTriggerParams,
  "action.pet.interact": PetInteractActionParams,
  "trigger.webhook": WebhookTriggerParams,
  "trigger.integration.event": IntegrationEventTriggerParams,
  "trigger.team": TeamTriggerParams,
  // Actions: characters
  "action.character.send": CharacterSendParams,
  "action.character.create": CharacterCreateParams,
  "action.character.update": CharacterUpdateParams,
  // Actions: agent
  "action.agent.turn": AgentTurnParams,
  // Actions: goals
  "action.goal.create": GoalCreateParams,
  "action.goal.get": GoalIdParams,
  "action.goal.list": GoalListParams,
  "action.goal.events": GoalEventsParams,
  "action.goal.updateObjective": GoalUpdateObjectiveParams,
  "action.goal.pause": GoalIdParams,
  "action.goal.resume": GoalIdParams,
  "action.goal.stop": GoalIdParams,
  "action.goal.preempt": GoalIdParams,
  "action.goal.updateConfig": GoalUpdateConfigParams,
  "action.goal.decomposeSubgoals": GoalIdParams,
  "action.goal.toggleSubgoal": GoalToggleSubgoalParams,
  "action.goal.clearSubgoals": GoalIdParams,
  "action.goal.delete": GoalIdParams,
  "action.goal.analytics": GoalAnalyticsParams,
  "action.goal.template.list": GoalTemplateListParams,
  "action.goal.template.createGoal": GoalTemplateCreateGoalParams,
  "action.goal.template.upsert": GoalTemplateUpsertParams,
  "action.goal.template.favorite": GoalTemplateFavoriteParams,
  "action.goal.template.delete": GoalTemplateIdParams,
  // Actions: teams
  "action.team.run": TeamRunParams,
  "action.team.task.dispatch": TeamTaskDispatchParams,
  "action.team.task.review": TeamTaskReviewParams,
  "action.team.reconcile": TeamReconcileParams,
  "action.team.compose": TeamComposeParams,
  "action.team.status": TeamStatusParams,
  "action.team.delegate": TeamDelegateParams,
  "action.team.message": TeamMessageParams,
  "action.plan.create": PlanCreateParams,
  "action.plan.get": PlanIdParams,
  "action.plan.list": PlanListParams,
  "action.plan.events": PlanEventsParams,
  "action.plan.updateDraft": PlanUpdateDraftParams,
  "action.plan.approve": PlanIdParams,
  "action.plan.reject": PlanRejectParams,
  "action.plan.refine": PlanRefineParams,
  "action.plan.pause": PlanIdParams,
  "action.plan.resume": PlanIdParams,
  "action.plan.cancel": PlanIdParams,
  "action.plan.delete": PlanIdParams,
  "action.plan.run": PlanIdParams,
  "action.plan.setStepStatus": PlanSetStepStatusParams,
  "action.scheduler.task.create": SchedulerTaskCreateParams,
  "action.scheduler.task.get": SchedulerTaskIdParams,
  "action.scheduler.task.list": SchedulerTaskListParams,
  "action.scheduler.task.update": SchedulerTaskUpdateParams,
  "action.scheduler.task.pause": SchedulerTaskIdParams,
  "action.scheduler.task.resume": SchedulerTaskIdParams,
  "action.scheduler.task.delete": SchedulerTaskIdParams,
  "action.scheduler.task.runNow": SchedulerTaskIdParams,
  "action.scheduler.task.executions": SchedulerTaskExecutionsParams,
  "action.scheduler.task.backfill": SchedulerTaskBackfillParams,
  "action.scheduler.task.export": SchedulerTaskExportParams,
  "action.scheduler.task.import": SchedulerTaskImportParams,
  "action.scheduler.status": z.object({}),
  "action.scheduler.statistics": z.object({}),
  "action.scheduler.upcoming": SchedulerLimitParams,
  "action.scheduler.executions.recent": SchedulerLimitParams,
  "action.scheduler.execution.get": SchedulerExecutionGetParams,
  "action.scheduler.event.trigger": SchedulerEventTriggerParams,
  "action.plan.step.dispatch": PlanStepDispatchParams,
  "action.team.create": TeamCreateParams,
  "action.team.update": TeamUpdateParams,
  // Actions: skills
  "action.skill.invoke": SkillInvokeParams,
  "action.skill.upsert": SkillUpsertParams,
  // Actions: twins
  "action.twin.rag": TwinRagParams,
  "action.twin.ingest": TwinIngestParams,
  "knowledge.source": KnowledgeSourceParams,
  "knowledge.parse": KnowledgeParseParams,
  "knowledge.transform": KnowledgeArtifactParams,
  "knowledge.chunk": KnowledgeArtifactParams,
  "knowledge.embed": KnowledgeArtifactParams,
  "knowledge.index": KnowledgeArtifactParams,
  "knowledge.publish": KnowledgeArtifactParams,
  "knowledge.retrieve": KnowledgeRetrieveParams,
  // Actions: memory
  "action.memory.recall": MemoryRecallParams,
  "action.memory.store": MemoryStoreParams,
  // Actions: connectors
  "action.connector.send": ConnectorSendParams,
  "action.connector.draft": ConnectorDraftParams,
  "action.connector.reaction": ConnectorReactionParams,
  "action.connector.delete": ConnectorDeleteParams,
  "action.connector.forward": ConnectorForwardParams,
  "action.connector.waitReply": ConnectorWaitReplyParams,
  // Actions: human-in-the-loop (ADR 0061 P2)
  "action.approval.request": ApprovalRequestParams,
  "action.humanInput.request": HumanInputRequestParams,
  // Actions: remote device steps (ADR 0061 P3)
  "action.mobile.camera": MobileCameraParams,
  "action.mobile.scanBarcode": MobileScanBarcodeParams,
  "action.mobile.location": MobileLocationParams,
  "action.mobile.share": MobileShareParams,
  "action.mobile.notify": MobileNotifyParams,
  // Actions: extensibility
  "action.mcp.invokeTool": McpInvokeToolParams,
  "action.plugin.invoke": PluginInvokeParams,
  "action.desktop.listApps": DesktopListAppsParams,
  "action.desktop.getAppState": DesktopGetAppStateParams,
  "action.desktop.queryElements": DesktopQueryElementsParams,
  "action.desktop.expandElement": DesktopExpandElementParams,
  "action.desktop.performAction": DesktopPerformActionParams,
  "trigger.desktop.event": DesktopEventTriggerParams,
  // System: integrated terminal
  "action.system.terminal": SystemTerminalParams,
  "action.terminal.session.open": TerminalSessionOpenParams,
  "action.terminal.session.run": TerminalSessionRunParams,
  "action.terminal.session.close": TerminalSessionCloseParams,
  "action.terminal.script": TerminalScriptParams,
  "action.terminal.readRecent": TerminalReadRecentParams,
  "action.terminal.waitForExit": TerminalWaitForExitParams,
  "trigger.terminal.command": TerminalCommandTriggerParams,
  // AI
  "ai.prompt": AiPromptParams,
  "ai.classify": AiClassifyParams,
  "ai.extract": AiExtractParams,
  "ai.embed": AiEmbedParams,
  "ai.browserModel": BrowserModelParams,
  "ai.council": AiCouncilParams,
  "ai.ensemble": AiEnsembleParams,
  // Flow
  "flow.branch": BranchParams,
  "flow.switch": SwitchParams,
  "flow.split": SplitParams,
  "flow.join": JoinParams,
  "flow.loop": LoopParams,
  "flow.wait": WaitParams,
  "flow.set": SetVariableParams,
  "flow.subworkflow": SubworkflowParams,
  "flow.catch": CatchParams,
  // Loop-body jump markers (schemaVersion 2) — no params beyond label/notes,
  // which live on node.data, not params.
  "flow.break": z.object({}).passthrough(),
  "flow.continue": z.object({}).passthrough(),
  // Data
  "data.transform": TransformParams,
  "data.aggregate": AggregateParams,
  "data.code": CodeParams,
  "data.template": TemplateParams,
  // IO
  "io.http": HttpRequestParams,
  "io.webhook.respond": WebhookRespondParams,
  "io.output": OutputParams,
  "io.answer": AnswerParams,
  "io.webClone": WebCloneParams,
  // Annotation
  "annotation.note": NoteParams,
  "annotation.group": GroupAnnotationParams,
  // OCR extraction (ADR-0024). One image source per run: a data URL, raw
  // base64 (+ mime), a fetchable URL, or `screen: true` to capture + OCR the
  // desktop. All fields optional so the inspector can build incrementally.
  "ocr.extract": z.object({
    dataUrl: z.string().optional(),
    imageBase64: z.string().optional(),
    mimeType: z.string().optional(),
    url: z.string().optional(),
    screen: z.boolean().optional(),
    languages: z.array(z.string()).optional(),
    provider: z.string().optional(),
    format: z.enum(["markdown", "text", "blocks"]).optional(),
    pageRange: z.string().optional(),
  }),
  // Eval nodes — single target per node instance (compose nodes for a matrix).
  "eval.run": z.object({
    datasetId: z.string(),
    targetKind: z.enum(["chat", "team", "workflow"]).optional(),
    model: z.string().optional(),
    characterId: z.string().optional(),
    teamId: z.string().optional(),
    workflowId: z.string().optional(),
    label: z.string().optional(),
    scorerIds: z.array(z.string()).optional(),
    k: z.number().int().min(1).optional(),
    split: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
  }),
  "eval.gate": z.object({
    runId: z.string(),
    minPassAt1: z.number().min(0).max(1).optional(),
    minPassHatK: z.number().min(0).max(1).optional(),
    minScorerPassRate: z.number().min(0).max(1).optional(),
    maxTotalCostUsd: z.number().min(0).optional(),
  }),
  // Local Git (Source Control panel backend — ADR-0038). `repoPath` is
  // optional; it defaults to the active workspace root at run time.
  "action.git.stage": z.object({
    repoPath: z.string().optional(),
    paths: z.array(z.string()).optional(),
  }),
  "action.git.commit": z.object({
    repoPath: z.string().optional(),
    message: z.string(),
    signoff: z.boolean().optional(),
  }),
  "action.site.build": z.object({
    siteId: z.string(),
    runtime: z.string().optional(),
    packageManager: z.string().optional(),
    installNetworkHosts: z.array(z.string()).optional(),
    buildNetworkHosts: z.array(z.string()).optional(),
  }),
  "action.site.deploy": z.object({
    siteId: z.string(),
    /** Omitted deploys the newest ready version. */
    versionId: z.string().optional(),
  }),
  "action.site.rollback": z.object({ siteId: z.string() }),
  "action.site.status": z.object({ siteId: z.string() }),
  "action.git.push": z.object({
    repoPath: z.string().optional(),
    remote: z.string().optional(),
    branch: z.string().optional(),
    setUpstream: z.boolean().optional(),
  }),
  "action.git.branch": z.object({
    repoPath: z.string().optional(),
    name: z.string(),
    checkout: z.boolean().optional(),
    from: z.string().optional(),
  }),
  // Stacked branches. `branches` and `tipBranch` are alternatives: name the
  // layers, or name the top of a chain and let the parent pointers supply them.
  "action.stack.list": z.object({
    repoPath: z.string().optional(),
    projectId: z.string().optional(),
  }),
  "action.stack.parent": z.object({
    repoPath: z.string().optional(),
    projectId: z.string().optional(),
    branch: z.string(),
    parent: z.string().optional(),
  }),
  "action.stack.validate": z.object({
    repoPath: z.string().optional(),
    projectId: z.string().optional(),
    branches: z.array(z.string()).optional(),
    tipBranch: z.string().optional(),
  }),
  "action.stack.restack": z.object({
    repoPath: z.string().optional(),
    projectId: z.string().optional(),
    branches: z.array(z.string()).optional(),
    tipBranch: z.string().optional(),
    onto: z.string().optional(),
  }),
  "action.stack.push": z.object({
    repoPath: z.string().optional(),
    projectId: z.string().optional(),
    branches: z.array(z.string()).optional(),
    tipBranch: z.string().optional(),
    remote: z.string().optional(),
  }),
  // Embedded code-server "Pro IDE" (ADR-0088 Phase 3). `root` is optional on
  // every kind — it defaults to the bound Pro IDE at run time. `autoStart` is
  // opt-in per node because bringing code-server up is a visible, potentially
  // several-hundred-megabyte act, not something addressing should do silently.
  "action.editor.open": z.object({
    root: z.string().optional(),
    path: z.string(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    autoStart: z.boolean().optional(),
  }),
  "action.editor.reveal": z.object({
    root: z.string().optional(),
    path: z.string(),
    autoStart: z.boolean().optional(),
  }),
  "action.editor.showDiff": z.object({
    root: z.string().optional(),
    path: z.string(),
    content: z.string(),
    title: z.string().optional(),
    autoStart: z.boolean().optional(),
  }),
  "action.editor.readActive": z.object({
    root: z.string().optional(),
    autoStart: z.boolean().optional(),
  }),
  "action.editor.applyEdit": z.object({
    root: z.string().optional(),
    path: z.string(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    autoStart: z.boolean().optional(),
  }),
  "action.editor.saveAll": z.object({
    root: z.string().optional(),
    path: z.string().optional(),
    autoStart: z.boolean().optional(),
  }),
  // Ultracode patterns (ADR-0022 addendum). Synthesizer-emitted only — the
  // params are shaped by `synthesize-ultracode.ts`, validated by the pattern
  // executors at run time, so the definition-level schema stays permissive.
  "pattern.multi-modal-sweep": z.object({}).passthrough(),
  "pattern.loop-until-dry": z.object({}).passthrough(),
  "pattern.adversarial-verify": z.object({}).passthrough(),
  "pattern.judge-panel": z.object({}).passthrough(),
  "pattern.completeness-critic": z.object({}).passthrough(),
  "pattern.synthesize": z.object({}).passthrough(),
} satisfies Record<WorkflowNodeKind, z.ZodTypeAny>

/**
 * Precise per-kind schema map type. Because `PARAMS_SCHEMAS` uses `satisfies`
 * (not a `Record<…>` annotation), each key keeps its specific zod type instead
 * of being widened to `z.ZodTypeAny`. That lets `WorkflowNodeParamsFor<K>`
 * (see `./typed-params`) infer the params shape per kind. The `satisfies`
 * clause still enforces exhaustiveness against `WorkflowNodeKind` at compile
 * time — a missing or extra key fails the build.
 */
export type ParamsSchemas = typeof PARAMS_SCHEMAS

/** Test-only export so the matrix test can iterate every kind. */
export const KNOWN_KINDS: readonly WorkflowNodeKind[] = WORKFLOW_NODE_KINDS

/**
 * Fetch the schema for a kind. Plugin / unknown kinds get a permissive
 * record so the validator returns no errors but the Schema Form (M4)
 * can drive its own JSON Schema validation.
 */
export function paramsSchemaFor(kind: WorkflowNodeKind): z.ZodTypeAny {
  return PARAMS_SCHEMAS[kind] ?? z.record(z.string(), z.unknown())
}
