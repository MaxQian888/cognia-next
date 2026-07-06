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

const ConnectorInboundParams = z.object({
  adapterId: requiredString("required"),
  conversationKey: optionalString,
  characterId: optionalString,
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
  scope: z.enum(["global", "character"]).optional(),
  characterId: optionalString,
  relevanceFloor: numberRange(0, 1).optional(),
  types: z.array(z.enum(["semantic", "episodic", "procedural"])).optional(),
})

const MemoryStoreParams = z.object({
  text: requiredString("required"),
  scope: z.enum(["global", "character"]).optional(),
  characterId: optionalString,
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

const PlanStepKind = z.enum([
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
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

const ConnectorSendParams = z.object({
  adapterId: requiredString("required"),
  conversationKey: requiredString("required"),
  content: requiredString("required"),
})

const ConnectorDraftParams = z.object({
  conversationKey: requiredString("required"),
  sessionId: requiredString("required"),
  content: requiredString("required"),
  sourceMessageId: optionalString,
  ttlMs: numberRange(0).optional(),
})

const ApprovalRequestParams = z.object({
  title: requiredString("required"),
  message: optionalString,
  /** How long to wait before the onTimeout policy applies. Default 1 h. */
  timeoutMs: numberRange(1_000).optional(),
  /** What a timeout means: route down "rejected" (default) or fail the step. */
  onTimeout: z.enum(["reject", "fail"]).optional(),
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
})

// ── GitHub Delivery ─────────────────────────────────────────────────────────

const GithubCommonParams = z.object({
  repoFullName: requiredString("required"),
  policyOverride: z.record(z.string(), z.unknown()).optional(),
})

const GithubPrNumberParams = GithubCommonParams.extend({
  prNumber: positiveInteger(),
})

const GithubIssueNumberParams = GithubCommonParams.extend({
  issueNumber: positiveInteger(),
})

const GithubOpenPrParams = GithubCommonParams.extend({
  head: requiredString("required"),
  base: requiredString("required"),
  title: requiredString("required"),
  body: optionalString,
  draft: z.boolean().optional(),
})

const GithubClosePrParams = GithubPrNumberParams

const GithubMergePrParams = GithubPrNumberParams.extend({
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  commitTitle: optionalString,
  commitMessage: optionalString,
})

const GithubReviewPrParams = GithubPrNumberParams.extend({
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: requiredString("required"),
  comments: z
    .array(
      z.object({
        path: requiredString("required"),
        position: positiveInteger(),
        body: requiredString("required"),
      })
    )
    .optional(),
})

const GithubReviewPrInlineParams = GithubPrNumberParams.extend({
  provider: requiredString("required"),
  model: requiredString("required"),
  apiKey: requiredString("required"),
  baseURL: optionalString,
  maxFiles: z.number().int().min(1, "minValue").max(30, "maxValue").optional(),
  focus: optionalString,
})

const GithubCommentPrParams = GithubPrNumberParams.extend({
  body: requiredString("required"),
})

const GithubCommentIssueParams = GithubIssueNumberParams.extend({
  body: requiredString("required"),
})

const GithubLabelList = z.array(requiredString("required")).optional()

const GithubLabelIssueParams = GithubIssueNumberParams.extend({
  add: GithubLabelList,
  remove: GithubLabelList,
}).refine(
  (v) =>
    (Array.isArray(v.add) && v.add.length > 0) || (Array.isArray(v.remove) && v.remove.length > 0),
  { message: "required", path: ["add"] }
)

const GithubCloseIssueParams = GithubIssueNumberParams.extend({
  reason: z.enum(["completed", "not_planned"]).optional(),
})

const GithubCreateReleaseParams = GithubCommonParams.extend({
  tag: requiredString("required"),
  targetCommitish: optionalString,
  name: optionalString,
  body: optionalString,
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
})

const GithubGenerateChangelogParams = GithubCommonParams.extend({
  since: requiredString("required"),
  currentVersion: optionalString,
})

const GithubPushTagParams = GithubCommonParams.extend({
  tag: requiredString("required"),
  sha: requiredString("required"),
})

const GithubRunIssueLoopParams = GithubIssueNumberParams.extend({
  worktreeMode: z.enum(["local", "e2b"]).optional(),
  branchTemplate: optionalString,
})

// ── Desktop automation ──────────────────────────────────────────────────────

const DesktopElementRef = z.union([requiredString("required"), z.array(z.string()).min(1)])
const DesktopRectParams = z.object({
  x: z.number(),
  y: z.number(),
  width: numberRange(1),
  height: numberRange(1),
})
const DesktopRouteTarget = z.object({
  connectionId: optionalString,
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

const DesktopBaseParams = z.object({
  selector: optionalString,
  timeoutMs: numberRange(0).optional(),
  retries: numberRange(0).optional(),
  processName: optionalString,
  windowTitle: optionalString,
  target: z.union([DesktopElementRef, DesktopRouteTarget]).optional(),
})

const DesktopTargetableParams = DesktopBaseParams.extend({
  locator: DesktopLocatorParams.optional(),
})

function hasDesktopElementTarget(v: { selector?: string; target?: unknown }): boolean {
  if (typeof v.selector === "string" && v.selector.trim() !== "") return true
  if (typeof v.target === "string" && v.target.length > 0) return true
  return Array.isArray(v.target) && typeof v.target[0] === "string" && v.target[0].length > 0
}

const DesktopScreenshotParams = DesktopBaseParams.extend({
  format: z.enum(["png", "jpeg"]).optional(),
  fullScreen: z.boolean().optional(),
  outputPath: optionalString,
  region: DesktopRectParams.optional(),
})

const DesktopFindElementParams = DesktopTargetableParams

const DesktopReadTreeParams = DesktopTargetableParams.extend({
  root: DesktopElementRef.optional(),
  maxDepth: numberRange(1).optional(),
})

const DesktopClickParams = DesktopTargetableParams.extend({
  elementRef: DesktopElementRef.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  double: z.boolean().optional(),
  clickCount: numberRange(1, 3).optional(),
})

const DesktopTypeParams = DesktopTargetableParams.extend({
  text: requiredString("required"),
  delayMs: numberRange(0).optional(),
})

const DesktopKeysParams = DesktopBaseParams.extend({
  chord: requiredString("required"),
})

const DesktopPasteParams = DesktopBaseParams.extend({
  text: requiredString("required"),
})

const DesktopLaunchAppParams = DesktopBaseParams.extend({
  app: requiredString("required"),
  action: z.enum(["launch", "focus"]).optional(),
})

const DesktopPatternKind = z.enum([
  "invoke",
  "toggle",
  "selectionItem",
  "value",
  "text",
  "rangeValue",
  "window",
  "transform",
  "expandCollapse",
  "scrollItem",
])

const DesktopInvokePatternParams = DesktopTargetableParams.extend({
  pattern: DesktopPatternKind.optional(),
  value: optionalString,
  args: z.record(z.string(), z.unknown()).optional(),
}).refine(hasDesktopElementTarget, { message: "required", path: ["target"] })

const DesktopWindowTargetParams = DesktopTargetableParams.refine(hasDesktopElementTarget, {
  message: "required",
  path: ["target"],
})

const DesktopWindowResizeParams = DesktopTargetableParams.extend({
  rect: DesktopRectParams.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: numberRange(1).optional(),
  height: numberRange(1).optional(),
})
  .refine(hasDesktopElementTarget, { message: "required", path: ["target"] })
  .refine(
    (v) =>
      v.rect !== undefined ||
      (typeof v.width === "number" && v.width > 0 && typeof v.height === "number" && v.height > 0),
    { message: "required", path: ["rect"] }
  )

const DesktopWaitParams = DesktopTargetableParams.extend({
  mode: z.enum(["appear", "disappear"]).optional(),
  pollMs: numberRange(1).optional(),
})

const DesktopEventKind = z.enum(["focus-changed", "structure-changed", "property-changed"])
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
    onItemError: z.enum(["fail", "skip", "break"]).optional(),
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
})

const SetVariableParams = z.object({
  variable: requiredString("required").regex(/^[a-z_][a-z0-9_]*$/i, "variableName"),
  value: requiredString("required"),
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
// Executors at `lib/workflow/nodes/terminal-session.ts`.
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
// Executor at `lib/workflow/nodes/terminal-script.ts`.
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
  "trigger.chat.message": ChatMessageTriggerParams,
  "trigger.goal.completed": GoalCompletedTriggerParams,
  "trigger.pet.event": PetEventTriggerParams,
  "action.pet.interact": PetInteractActionParams,
  "trigger.webhook": WebhookTriggerParams,
  "trigger.github.webhook": WebhookTriggerParams,
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
  // Actions: memory
  "action.memory.recall": MemoryRecallParams,
  "action.memory.store": MemoryStoreParams,
  // Actions: connectors
  "action.connector.send": ConnectorSendParams,
  "action.connector.draft": ConnectorDraftParams,
  // Actions: human-in-the-loop (ADR 0061 P2)
  "action.approval.request": ApprovalRequestParams,
  // Actions: remote device steps (ADR 0061 P3)
  "action.mobile.camera": MobileCameraParams,
  "action.mobile.scanBarcode": MobileScanBarcodeParams,
  "action.mobile.location": MobileLocationParams,
  "action.mobile.share": MobileShareParams,
  "action.mobile.notify": MobileNotifyParams,
  // Actions: extensibility
  "action.mcp.invokeTool": McpInvokeToolParams,
  "action.plugin.invoke": PluginInvokeParams,
  "action.github.openPr": GithubOpenPrParams,
  "action.github.closePr": GithubClosePrParams,
  "action.github.mergePr": GithubMergePrParams,
  "action.github.reviewPr": GithubReviewPrParams,
  "action.github.reviewPrInline": GithubReviewPrInlineParams,
  "action.github.commentPr": GithubCommentPrParams,
  "action.github.commentIssue": GithubCommentIssueParams,
  "action.github.labelIssue": GithubLabelIssueParams,
  "action.github.closeIssue": GithubCloseIssueParams,
  "action.github.createRelease": GithubCreateReleaseParams,
  "action.github.generateChangelog": GithubGenerateChangelogParams,
  "action.github.pushTag": GithubPushTagParams,
  "action.github.runIssueLoop": GithubRunIssueLoopParams,
  "action.desktop.screenshot": DesktopScreenshotParams,
  "action.desktop.findElement": DesktopFindElementParams,
  "action.desktop.readTree": DesktopReadTreeParams,
  "action.desktop.click": DesktopClickParams,
  "action.desktop.type": DesktopTypeParams,
  "action.desktop.keys": DesktopKeysParams,
  "action.desktop.invokePattern": DesktopInvokePatternParams,
  "action.desktop.windowFocus": DesktopWindowTargetParams,
  "action.desktop.windowClose": DesktopWindowTargetParams,
  "action.desktop.windowResize": DesktopWindowResizeParams,
  "action.desktop.wait": DesktopWaitParams,
  "action.desktop.paste": DesktopPasteParams,
  "action.desktop.launchApp": DesktopLaunchAppParams,
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
