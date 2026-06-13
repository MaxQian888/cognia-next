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

const ManualTriggerParams = z.object({})

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

// ── AI primitives ──────────────────────────────────────────────────────────

// ai.prompt v2 additions, also accepted by the classify/extract delegators.
// All optional — v1 nodes validate against the same (superset) schema.
const aiRoutedFields = {
  /** "routed" consults the provider-routing engine instead of explicit creds. */
  mode: z.enum(["explicit", "routed"]).optional(),
  /** Routed mode: model alias resolved through the mapping registry. */
  modelAlias: optionalString,
  /** PII gate applied before any text egress. */
  piiGate: z.enum(["off", "block", "redact"]).optional(),
}

const AiPromptParams = z.object({
  ...aiRoutedFields,
  provider: optionalString,
  model: optionalString,
  apiKey: optionalString,
  baseURL: optionalString,
  systemPrompt: optionalString,
  userPrompt: requiredString("required"),
  temperature: numberRange(0, 2).optional(),
  // Structured output (B1): "json" parses the completion into output.structured.
  responseFormat: z.enum(["text", "json"]).optional(),
  jsonSchema: optionalString,
})

const AiClassifyParams = z.object({
  ...aiRoutedFields,
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
  ...aiRoutedFields,
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
  "trigger.webhook": WebhookTriggerParams,
  "trigger.github.webhook": WebhookTriggerParams,
  "trigger.team": z.object({}),
  // Actions: characters
  "action.character.send": CharacterSendParams,
  "action.character.create": CharacterCreateParams,
  "action.character.update": CharacterUpdateParams,
  // Actions: agent
  "action.agent.turn": AgentTurnParams,
  // Actions: teams
  "action.team.run": TeamRunParams,
  "action.team.task.dispatch": TeamTaskDispatchParams,
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
  // Actions: extensibility
  "action.mcp.invokeTool": McpInvokeToolParams,
  "action.plugin.invoke": PluginInvokeParams,
  // GitHub Delivery (param shapes are deliberately permissive at this layer —
  // each node's inspector form provides richer client-side validation.)
  "action.github.openPr": z.object({}).passthrough(),
  "action.github.closePr": z.object({}).passthrough(),
  "action.github.mergePr": z.object({}).passthrough(),
  "action.github.reviewPr": z.object({}).passthrough(),
  "action.github.reviewPrInline": z.object({}).passthrough(),
  "action.github.commentPr": z.object({}).passthrough(),
  "action.github.commentIssue": z.object({}).passthrough(),
  "action.github.labelIssue": z.object({}).passthrough(),
  "action.github.closeIssue": z.object({}).passthrough(),
  "action.github.createRelease": z.object({}).passthrough(),
  "action.github.generateChangelog": z.object({}).passthrough(),
  "action.github.pushTag": z.object({}).passthrough(),
  "action.github.runIssueLoop": z.object({}).passthrough(),
  // Desktop UI automation — param shapes are permissive; inspector forms
  // provide richer validation against the lib/automation/types.ts mirror.
  "action.desktop.screenshot": z.object({}).passthrough(),
  "action.desktop.findElement": z.object({}).passthrough(),
  "action.desktop.readTree": z.object({}).passthrough(),
  "action.desktop.click": z.object({}).passthrough(),
  "action.desktop.type": z.object({}).passthrough(),
  "action.desktop.keys": z.object({}).passthrough(),
  "action.desktop.invokePattern": z.object({}).passthrough(),
  "action.desktop.windowFocus": z.object({}).passthrough(),
  "action.desktop.windowClose": z.object({}).passthrough(),
  "action.desktop.windowResize": z.object({}).passthrough(),
  "action.desktop.wait": z.object({}).passthrough(),
  "action.desktop.paste": z.object({}).passthrough(),
  "action.desktop.launchApp": z.object({}).passthrough(),
  "trigger.desktop.event": z.object({}).passthrough(),
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
  "data.code": CodeParams,
  "data.template": TemplateParams,
  // IO
  "io.http": HttpRequestParams,
  "io.webhook.respond": WebhookRespondParams,
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
