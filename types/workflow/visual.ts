/**
 * Visual workflows — n8n-style graph orchestration over cognia-next runtime
 * entities (Characters, Agent Teams, Skills, Twins, Connectors, MCP, Plugins).
 *
 * NOT to be confused with the existing `./workflow.ts` — that file is the
 * higher-level WorkflowType / WorkflowDefinition system used by PPT
 * generation. This file is the data model for the visual graph editor and
 * its execution engine.
 *
 * Four Dexie tables back the subsystem (see `lib/db/schema.ts` v22):
 *
 *   • `workflows`         — visual workflow definitions (graph + settings)
 *   • `workflowRuns`      — one row per execution (status, frozen snapshot)
 *   • `workflowRunEvents` — durable per-step event log (live-queried by UI)
 *   • `workflowTriggers`  — registered triggers (cron, webhook, inbound, ...)
 *
 * The hybrid runtime split (Rust triggers + TS orchestration) is documented in
 * `docs/content/docs/adr/0011-workflows-subsystem.md`. The shapes here are the
 * wire format for both the editor (TS-only) and the IPC contract (TS ↔ Rust).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Node taxonomy. Namespaced as `<group>.<kind>` so plugin-contributed nodes
// can use their own prefix (e.g., `myplugin.action.foo`) without colliding.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowNodeKind =
  // Triggers
  | "trigger.manual"
  | "trigger.cron"
  | "trigger.connector.inbound"
  | "trigger.chat.message"
  | "trigger.webhook"
  | "trigger.github.webhook"
  | "trigger.team"
  | "trigger.goal.completed"
  // Actions on cognia-next runtime entities
  | "action.character.send"
  | "action.character.create"
  | "action.character.update"
  | "action.team.run"
  | "action.team.create"
  | "action.team.update"
  | "action.team.task.dispatch"
  | "action.skill.invoke"
  | "action.skill.upsert"
  | "action.twin.rag"
  | "action.twin.ingest"
  | "action.connector.send"
  | "action.connector.draft"
  | "action.mcp.invokeTool"
  | "action.plugin.invoke"
  // GitHub Delivery (provided by the github-delivery plugin)
  | "action.github.openPr"
  | "action.github.closePr"
  | "action.github.mergePr"
  | "action.github.reviewPr"
  | "action.github.reviewPrInline"
  | "action.github.commentPr"
  | "action.github.commentIssue"
  | "action.github.labelIssue"
  | "action.github.closeIssue"
  | "action.github.createRelease"
  | "action.github.generateChangelog"
  | "action.github.pushTag"
  | "action.github.runIssueLoop"
  // Desktop UI automation (provided by the automation subsystem — see
  // `docs/superpowers/specs/2026-05-12-ui-automation-subsystem-design.md`)
  | "action.desktop.screenshot"
  | "action.desktop.findElement"
  | "action.desktop.readTree"
  | "action.desktop.click"
  | "action.desktop.type"
  | "action.desktop.keys"
  | "action.desktop.invokePattern"
  | "action.desktop.windowFocus"
  | "action.desktop.windowClose"
  | "action.desktop.windowResize"
  | "action.desktop.wait"
  | "trigger.desktop.event"
  // Wave 3 — integrated terminal action. Runs a command in a dock tab
  // (or spawns a fresh tab), surfaces stdout / exit code downstream.
  // Reuses `lib/terminal/run-in-dock.ts` so the consent + tab gating
  // matches the chat affordance and the agent's MCP tool path.
  | "action.system.terminal"
  // AI primitives
  | "ai.prompt"
  | "ai.classify"
  | "ai.extract"
  | "ai.embed"
  // Flow control
  | "flow.branch"
  | "flow.switch"
  | "flow.split"
  | "flow.join"
  | "flow.loop"
  | "flow.wait"
  | "flow.set"
  | "flow.subworkflow"
  // Data
  | "data.transform"
  | "data.code"
  | "data.template"
  // I/O
  | "io.http"
  | "io.webhook.respond"
  // Annotation
  | "annotation.note"
  | "annotation.group"

export type WorkflowNodeCategory =
  | "trigger"
  | "action"
  | "ai"
  | "flow"
  | "data"
  | "io"
  | "annotation"

export function workflowNodeCategory(kind: WorkflowNodeKind): WorkflowNodeCategory {
  const head = kind.split(".")[0]
  if (head === "trigger") return "trigger"
  if (head === "action") return "action"
  if (head === "ai") return "ai"
  if (head === "flow") return "flow"
  if (head === "data") return "data"
  if (head === "io") return "io"
  return "annotation"
}

/**
 * The full enumeration of node kinds. Useful for runtime iteration (e.g.,
 * the node search sidebar) without re-listing the union by hand.
 */
export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [
  "trigger.manual",
  "trigger.cron",
  "trigger.connector.inbound",
  "trigger.chat.message",
  "trigger.webhook",
  "trigger.github.webhook",
  "trigger.team",
  "trigger.goal.completed",
  "action.character.send",
  "action.character.create",
  "action.character.update",
  "action.team.run",
  "action.team.create",
  "action.team.update",
  "action.team.task.dispatch",
  "action.skill.invoke",
  "action.skill.upsert",
  "action.twin.rag",
  "action.twin.ingest",
  "action.connector.send",
  "action.connector.draft",
  "action.mcp.invokeTool",
  "action.plugin.invoke",
  "action.github.openPr",
  "action.github.closePr",
  "action.github.mergePr",
  "action.github.reviewPr",
  "action.github.reviewPrInline",
  "action.github.commentPr",
  "action.github.commentIssue",
  "action.github.labelIssue",
  "action.github.closeIssue",
  "action.github.createRelease",
  "action.github.generateChangelog",
  "action.github.pushTag",
  "action.github.runIssueLoop",
  "action.desktop.screenshot",
  "action.desktop.findElement",
  "action.desktop.readTree",
  "action.desktop.click",
  "action.desktop.type",
  "action.desktop.keys",
  "action.desktop.invokePattern",
  "action.desktop.windowFocus",
  "action.desktop.windowClose",
  "action.desktop.windowResize",
  "action.desktop.wait",
  "trigger.desktop.event",
  "action.system.terminal",
  "ai.prompt",
  "ai.classify",
  "ai.extract",
  "ai.embed",
  "flow.branch",
  "flow.switch",
  "flow.split",
  "flow.join",
  "flow.loop",
  "flow.wait",
  "flow.set",
  "flow.subworkflow",
  "data.transform",
  "data.code",
  "data.template",
  "io.http",
  "io.webhook.respond",
  "annotation.note",
  "annotation.group",
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Definition shape — what gets serialized to JSON / Dexie / the workflow JSON
// export format. Modeled on n8n with two simplifications: flat edges (no
// per-output-type nested map) and expression strings for variable passthrough.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level shape version. Bumped on breaking changes to the JSON shape.
 * The optional `variables` map added alongside the Settings tab is additive
 * (every prior row stays valid) so it does NOT require a version bump.
 */
export type VisualWorkflowSchemaVersion = 1

/**
 * The visual workflow definition. Named `VisualWorkflow` (not
 * `WorkflowDefinition`) to avoid colliding with the PPT-generation
 * `WorkflowDefinition` already exported from `./workflow.ts`.
 */
export interface VisualWorkflow {
  /** Stable surrogate id; never reuse across renames. */
  id: string
  schemaVersion: VisualWorkflowSchemaVersion
  name: string
  description?: string
  /** Optional emoji or lucide icon name for the library card. */
  icon?: string
  tags?: string[]
  isTemplate?: boolean
  isBuiltIn?: boolean
  /**
   * Optional complexity hint used by the templates picker to group / filter
   * built-in examples. Author-supplied; not derived. Templates without a
   * value fall through to the picker's default bucket.
   */
  complexity?: "starter" | "intermediate" | "advanced"
  /**
   * Library folder this workflow lives in. `ROOT_FOLDER_ID` ("root") = the
   * library root. Stored as a non-null sentinel string (never `null`/
   * `undefined`) so Dexie's `where("folderId")` range queries can index it —
   * IndexedDB cannot match null keys. See `types/workflow/folder.ts`.
   */
  folderId?: string
  createdAt: number
  updatedAt: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  settings: WorkflowSettings
  /** Refs only — never values. Resolved at run time from the keychain. */
  credentials?: Record<string, WorkflowCredentialRef>
  /**
   * Author-time environment variables, referenced in expressions as
   * `{{ $vars.KEY }}`. Distinct from `staticData` (run-mutable). Keys must be
   * valid identifiers so they resolve through the expression tokenizer.
   */
  variables?: Record<string, string>
  /** UI-only test data pinned per node so the inspector can replay outputs. */
  pinData?: Record<string, unknown>
  /** Cross-run mutable state. Persisted on the workflow row, not snapshots. */
  staticData?: Record<string, unknown>
  /** Last saved canvas viewport so reopening lands the user where they were. */
  viewport?: WorkflowViewport
}

export interface WorkflowNode<TParams = Record<string, unknown>> {
  /** Graph-local unique id (e.g., "n_start"). Stable across renames. */
  id: string
  type: WorkflowNodeKind
  /** Per-node-type schema version; nodes evolve their params shape via this. */
  typeVersion: number
  position: { x: number; y: number }
  data: WorkflowNodeData<TParams>
  /** React Flow v12 hydration-friendly: store on save, restore on load. */
  width?: number
  height?: number
}

/**
 * The index signature on the next interface is required so it satisfies
 * React Flow v12's `Node<TData extends Record<string, unknown>>` constraint
 * without forcing every consumer to widen at the boundary.
 */
export interface WorkflowNodeData<TParams = Record<string, unknown>> {
  [key: string]: unknown
  /** User-visible label. Often the node type's default at create time. */
  label: string
  /** Per-node-kind params. Validated by the kind's zod schema in NodeRegistry. */
  params: TParams
  /** Optional sticky-note text shown beneath the node body. */
  notes?: string
  /** Map of param-path → credential ref id (e.g., {"apiKey": "cred_abc"}). */
  credentialRefs?: Record<string, string>
  /** Whether this node is currently disabled (skipped during runs). */
  disabled?: boolean
  /**
   * Provenance: `"ai"` if the node was authored by the workflow-AI
   * agent (via the `cognia-workflow-ai` plugin), `"user"` for manual
   * authoring, undefined for nodes that pre-date the field.
   */
  authoredBy?: "ai" | "user"
}

export interface WorkflowEdge {
  id: string
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
  /** Optional label rendered on the edge (e.g., "true" / "false" for branch). */
  label?: string
  data?: { kind?: WorkflowEdgeKind }
}

export type WorkflowEdgeKind = "default" | "conditional" | "parallel" | "loop" | "error"

export interface WorkflowSettings {
  errorPolicy: "stop" | "continue" | "branch"
  /** Hard ceiling on a single run's wall-clock time. */
  timeoutMs: number
  /** How many runs of THIS workflow may execute concurrently. */
  concurrency: number
  /**
   * Per ADR-0022 §3.7. Max in-flight nodes WITHIN a single run for the
   * ready-set scheduler. Optional and defaults to 1 in `runWorkflow` to
   * preserve the legacy sequential behavior. NOT the same as `concurrency`
   * (that field caps concurrent RUNS of the same workflow).
   */
  maxConcurrency?: number
  retryDefaults: WorkflowRetryPolicy
  /** Default cron timezone — falls back to AppSettings.timezone. */
  timezone?: string
}

export interface WorkflowRetryPolicy {
  attempts: number
  backoff: "exponential" | "fixed"
  baseMs: number
  /** Optional max backoff cap for exponential mode. */
  maxMs?: number
}

export interface WorkflowCredentialRef {
  id: string
  name: string
  /** Optional display kind ("anthropic_api_key", "telegram_bot_token", …). */
  kind?: string
}

export interface WorkflowViewport {
  x: number
  y: number
  zoom: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Run lifecycle — separate from definitions.
// ─────────────────────────────────────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"

/**
 * Trigger envelope — produced by triggers (manual button, cron daemon, webhook
 * receiver, connector inbound tap, chat-message hook). The orchestrator
 * accepts any TriggerEvent and decides whether to fan-out via a graph node.
 */
export interface TriggerEvent {
  workflowId: string
  /** Which trigger node kind produced this event. */
  kind: WorkflowNodeKind
  /** Free-form payload — chat message body, webhook headers/body, etc. */
  payload: unknown
  /** Wall-clock when the trigger fired (Rust mirror or webview Date.now()). */
  originAt: number
  /** Optional binding identifier — adapter id, conversation key, session id. */
  binding?: WorkflowTriggerBinding
}

export interface WorkflowTriggerBinding {
  adapterId?: string
  sessionId?: string
  conversationKey?: string
  characterId?: string
  /** Scopes a `trigger.goal.completed` subscription to a specific goal id. */
  goalId?: string
}

/**
 * Origin of a run that did NOT come from the workflow's own trigger node.
 * Today this means a Claude tool invocation (`wf_run_workflow_by_name`) fired
 * from an IM session, or a desktop UI button, or an HTTP API call. Distinct
 * from `WorkflowTriggerBinding` (which describes the trigger node payload):
 * a manual run from IM has `triggerKind: "trigger.manual"` AND
 * `triggeredBy.source: "im"`. The IM-side progress-runner subscribes to
 * runs where `triggeredBy.source === "im"` and fans `workflowRunEvents` out
 * to `triggeredBy.conversationKey` via `enqueueOutbound`.
 */
export interface WorkflowTriggeredFrom {
  source: "im" | "ui" | "api"
  adapterId?: string
  conversationKey?: string
  sessionId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Dexie row shapes (what `lib/db/schema.ts` v22 stores).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `workflows` table row. Identical shape to `VisualWorkflow` — kept as
 * its own alias so callers reading the table can grep for the row type.
 */
export type WorkflowRow = VisualWorkflow

export interface WorkflowRunRow {
  id: string
  workflowId: string
  status: RunStatus
  /** Which trigger kind started this run. */
  triggerKind: WorkflowNodeKind
  triggerPayload: unknown
  triggerBinding?: WorkflowTriggerBinding
  input?: unknown
  output?: unknown
  error?: WorkflowRunError
  startedAt: number
  completedAt?: number
  /**
   * Frozen workflow definition at run start. Editing the live workflow doesn't
   * retroactively change this run; re-runs from history use the snapshot.
   */
  workflowSnapshot: VisualWorkflow
  /** Highest stepId successfully completed; resume picks up at the next one. */
  lastCompletedStepId?: string
  /**
   * Origin metadata for runs whose `trigger.kind === "trigger.manual"` was
   * fired by an external surface (IM Claude tool, desktop button, HTTP API)
   * rather than the workflow's own trigger node. Drives IM-side progress
   * fan-out — see `lib/connectors/a2ui-bridge/workflow-progress-runner.ts`.
   */
  triggeredBy?: WorkflowTriggeredFrom
}

export interface WorkflowRunError {
  message: string
  stack?: string
  /** Which node raised the failure (if any — engine-level errors omit this). */
  nodeId?: string
  /** Whether the underlying error is retryable (per the node implementation). */
  retryable?: boolean
  /**
   * Discriminator for engine-level failure modes consumers may want to handle
   * differently from a generic node failure (e.g. `"timeout"` for wall-clock
   * expiry). Absent on ordinary executor errors.
   */
  code?: "timeout" | "aborted" | string
}

export type RunEventType =
  | "run_started"
  | "run_progress"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "step_skipped"
  | "run_log"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "step.long_running.checkpoint"
  | "step.long_running.progress"

export type RunEventLogLevel = "debug" | "info" | "warn" | "error"

export interface WorkflowRunEventRow {
  id: string
  runId: string
  ts: number
  type: RunEventType
  /** Node id if the event is step-scoped; absent for run-scoped events. */
  stepId?: string
  level?: RunEventLogLevel
  payload?: unknown
}

export interface WorkflowTriggerRow {
  id: string
  workflowId: string
  kind: WorkflowNodeKind
  enabled: boolean
  /** Cron expression (only meaningful for `trigger.cron`). */
  cron?: string
  /** Pre-computed next-fire timestamp (used by the editor preview). */
  nextFireAt?: number
  /** Webhook path or connector binding (kind-dependent). */
  webhookPath?: string
  binding?: WorkflowTriggerBinding
  createdAt: number
  updatedAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Step execution — passed to `NodeExecutor.execute(ctx)` at run time.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-step execution context. The runtime constructs one of these per
 * `(runId, stepId)` pair and passes it to the registered NodeExecutor.
 */
export interface StepExecutionContext<TParams = Record<string, unknown>> {
  runId: string
  workflowId: string
  stepId: string
  /** Resolved params after expression evaluation. */
  params: TParams
  /**
   * Outputs from upstream nodes, keyed by node id. The expression resolver
   * uses this map to evaluate `{{ $node['n_id'].out.field }}` references.
   */
  upstream: Record<string, unknown>
  /** Trigger payload (echoed from the run for trigger-aware nodes). */
  trigger: TriggerEvent
  /** AbortSignal that fires on workflow timeout / user cancel. */
  signal: AbortSignal
  /** Per-run logger; appends to `workflowRunEvents`. */
  log: (level: RunEventLogLevel, message: string, payload?: unknown) => void
  /** Resolves a credential ref id to its keychain value. */
  resolveSecret: (refId: string) => Promise<string | undefined>
}

/**
 * Result returned by a NodeExecutor. `decision` is set by branch/switch nodes
 * so the orchestrator knows which downstream edge to follow.
 */
export interface StepExecutionResult<TOutput = unknown> {
  output: TOutput
  /** Branch name(s) the orchestrator should follow. Used by branch/switch. */
  decision?: string | string[]
  /** Optional structured log entries. */
  logs?: Array<{ level: RunEventLogLevel; message: string; payload?: unknown }>
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC contract — exact shapes used by `lib/workflow/runtime/tauri-bridge.ts`
// and `src-tauri/src/workflow/commands.rs`. Keep these in lockstep.
// ─────────────────────────────────────────────────────────────────────────────

export interface PersistRunStateInput {
  runId: string
  workflowId: string
  status: RunStatus
  lastStepId?: string
  /**
   * Frozen workflow definition; only included on first persist. Subsequent
   * persists omit the snapshot to keep the IPC payload small.
   */
  snapshot?: VisualWorkflow
}

export interface InFlightRunRow {
  runId: string
  workflowId: string
  lastStepId?: string
  snapshot: VisualWorkflow
  startedAt: number
}

export interface RegisterTriggerInput {
  workflowId: string
  triggerId: string
  kind: WorkflowNodeKind
  cron?: string
  webhookPath?: string
  /** HTTP method the receiver allows. Defaults to POST. */
  webhookMethod?: string
  /** Optional HMAC secret for X-Signature-256 verification. */
  webhookHmacSecret?: string
  /** HTTP status code returned to the caller. Defaults to 200. */
  webhookResponseStatus?: number
  /** Optional response body template. */
  webhookResponseBody?: string
  /**
   * Which signature header convention to verify against:
   *   - "cognia" (default) → reads `x-signature-256: sha256=<hex>`
   *   - "github"           → reads `x-hub-signature-256: sha256=<hex>`
   * Used by the Rust verifier; the trigger node kind alone (e.g.
   * trigger.github.webhook) is also a valid signal but this field is the
   * authoritative override.
   */
  signatureMode?: "cognia" | "github"
  binding?: WorkflowTriggerBinding
  enabled: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — the editor and seed loaders use these when creating new entities.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  errorPolicy: "stop",
  timeoutMs: 600_000,
  concurrency: 1,
  retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
}

export const DEFAULT_RETRY_POLICY: WorkflowRetryPolicy = {
  attempts: 3,
  backoff: "exponential",
  baseMs: 1000,
  maxMs: 30_000,
}
