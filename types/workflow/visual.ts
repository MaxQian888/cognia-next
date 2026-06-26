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
  // Full tool-enabled agent turn (sidecar on desktop; text-only fallback on
  // web). User-placeable — the workflow-native "ask an agent" primitive.
  | "action.agent.turn"
  // Goal lifecycle actions (mirrors lib/plugin/api/goal-api.ts over
  // GoalRuntime so workflow nodes preserve redaction, guardrails, events, and
  // terminal fan-out side effects).
  | "action.goal.create"
  | "action.goal.get"
  | "action.goal.list"
  | "action.goal.events"
  | "action.goal.updateObjective"
  | "action.goal.pause"
  | "action.goal.resume"
  | "action.goal.stop"
  | "action.goal.preempt"
  | "action.goal.updateConfig"
  | "action.goal.decomposeSubgoals"
  | "action.goal.toggleSubgoal"
  | "action.goal.clearSubgoals"
  | "action.goal.delete"
  | "action.goal.analytics"
  | "action.goal.template.list"
  | "action.goal.template.createGoal"
  | "action.goal.template.upsert"
  | "action.goal.template.favorite"
  | "action.goal.template.delete"
  | "action.team.run"
  | "action.team.create"
  | "action.team.update"
  | "action.team.task.dispatch"
  // User-placeable plan lifecycle actions (ADR-0045). These expose the
  // AgentPlan runtime and DB readers without going through the synthesized
  // per-step dispatch node below.
  | "action.plan.create"
  | "action.plan.get"
  | "action.plan.list"
  | "action.plan.events"
  | "action.plan.updateDraft"
  | "action.plan.approve"
  | "action.plan.reject"
  | "action.plan.refine"
  | "action.plan.pause"
  | "action.plan.resume"
  | "action.plan.cancel"
  | "action.plan.delete"
  | "action.plan.run"
  | "action.plan.setStepStatus"
  // Native scheduler task actions. These wrap lib/scheduler TaskScheduler so
  // workflows can manage existing scheduled-task capability directly.
  | "action.scheduler.task.create"
  | "action.scheduler.task.get"
  | "action.scheduler.task.list"
  | "action.scheduler.task.update"
  | "action.scheduler.task.pause"
  | "action.scheduler.task.resume"
  | "action.scheduler.task.delete"
  | "action.scheduler.task.runNow"
  | "action.scheduler.task.executions"
  | "action.scheduler.task.backfill"
  | "action.scheduler.task.export"
  | "action.scheduler.task.import"
  | "action.scheduler.status"
  | "action.scheduler.statistics"
  | "action.scheduler.upcoming"
  | "action.scheduler.executions.recent"
  | "action.scheduler.execution.get"
  | "action.scheduler.event.trigger"
  // Unified Plan Execution Hub (ADR-0045). Synthesizer-emitted only: one per
  // PlanStep. Looks up the per-run PlanRunContext and executes the step by its
  // `kind` (agent_turn / approval_gate / sub_workflow / tool_call /
  // teammate_dispatch). Not placed by users in the editor.
  | "action.plan.step.dispatch"
  | "action.skill.invoke"
  | "action.skill.upsert"
  | "action.twin.rag"
  | "action.twin.ingest"
  // Autonomous long-term memory (lib/memory): hybrid recall + explicit store.
  | "action.memory.recall"
  | "action.memory.store"
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
  // Local Git (Source Control panel backend — ADR-0038)
  | "action.git.stage"
  | "action.git.commit"
  | "action.git.push"
  | "action.git.branch"
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
  | "action.desktop.paste"
  | "action.desktop.launchApp"
  | "trigger.desktop.event"
  // Wave 3 — integrated terminal action. Runs a command in a dock tab
  // (or spawns a fresh tab), surfaces stdout / exit code downstream.
  // Reuses `lib/terminal/run-in-dock.ts` so the consent + tab gating
  // matches the chat affordance and the agent's MCP tool path.
  | "action.system.terminal"
  // Persistent terminal sessions — open once, run several commands in the
  // same shell/cwd, close (or let the orchestrator's run cleanup close).
  // Dock mode shares the consent gate with `action.system.terminal`;
  // `unattended: true` routes through the headless policy layer
  // (`lib/terminal/headless-exec.ts`).
  | "action.terminal.session.open"
  | "action.terminal.session.run"
  | "action.terminal.session.close"
  // Run a script file (.sh / .ps1 / .py / .js / …) under the right
  // interpreter — reuses `lib/terminal/script-runner.ts:detectScriptType`
  // for the extension → interpreter mapping; same dock / unattended gates
  // as `action.system.terminal`.
  | "action.terminal.script"
  // Dock parity nodes for the remaining `terminal_dock_*` actions: read the
  // recent-commands ring of a tab, or wait for the next OSC 633 command_end.
  | "action.terminal.readRecent"
  | "action.terminal.waitForExit"
  // Fires when a command finishes in a *user-spawned* dock tab (agent /
  // workflow-spawned tabs are excluded to prevent self-trigger loops).
  // TS-hook trigger — fan-out lives in `lib/terminal/command-trigger.ts`.
  | "trigger.terminal.command"
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
  | "flow.break"
  | "flow.continue"
  // Terminal-failure catch (run-fallback safety net). Executes only when the
  // run hits a terminal failure (retries exhausted / errorPolicy=stop / no
  // error edge); its downstream is the recovery / notify path. Input is the
  // error envelope `{ stepId, message, code }`. See orchestrator's
  // terminal-failure block + `lib/workflow/runtime/failure-handler.ts`.
  | "flow.catch"
  // Data
  | "data.transform"
  | "data.code"
  | "data.template"
  | "ocr.extract"
  // Eval (agent evaluation engine)
  | "eval.run"
  | "eval.gate"
  // I/O
  | "io.http"
  | "io.webhook.respond"
  // Annotation
  | "annotation.note"
  | "annotation.group"
  // Ultracode orchestration patterns (ADR-0022 addendum). Higher-order
  // Agent-Team nodes that fan out tool-enabled teammate dispatches and apply a
  // quality pattern. Synthesizer-emitted only — not placed by users in the
  // editor. See `lib/ai/agent/team/patterns/`.
  | "pattern.multi-modal-sweep"
  | "pattern.loop-until-dry"
  | "pattern.adversarial-verify"
  | "pattern.judge-panel"
  | "pattern.completeness-critic"
  | "pattern.synthesize"

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
  // OCR extraction is a data-producing node (ADR-0024).
  if (head === "ocr") return "data"
  // Eval nodes run / judge agent evaluations — a flavour of action.
  if (head === "eval") return "action"
  // Ultracode pattern nodes are a flavour of action.
  if (head === "pattern") return "action"
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
  "action.agent.turn",
  "action.goal.create",
  "action.goal.get",
  "action.goal.list",
  "action.goal.events",
  "action.goal.updateObjective",
  "action.goal.pause",
  "action.goal.resume",
  "action.goal.stop",
  "action.goal.preempt",
  "action.goal.updateConfig",
  "action.goal.decomposeSubgoals",
  "action.goal.toggleSubgoal",
  "action.goal.clearSubgoals",
  "action.goal.delete",
  "action.goal.analytics",
  "action.goal.template.list",
  "action.goal.template.createGoal",
  "action.goal.template.upsert",
  "action.goal.template.favorite",
  "action.goal.template.delete",
  "action.team.run",
  "action.team.create",
  "action.team.update",
  "action.team.task.dispatch",
  "action.plan.create",
  "action.plan.get",
  "action.plan.list",
  "action.plan.events",
  "action.plan.updateDraft",
  "action.plan.approve",
  "action.plan.reject",
  "action.plan.refine",
  "action.plan.pause",
  "action.plan.resume",
  "action.plan.cancel",
  "action.plan.delete",
  "action.plan.run",
  "action.plan.setStepStatus",
  "action.scheduler.task.create",
  "action.scheduler.task.get",
  "action.scheduler.task.list",
  "action.scheduler.task.update",
  "action.scheduler.task.pause",
  "action.scheduler.task.resume",
  "action.scheduler.task.delete",
  "action.scheduler.task.runNow",
  "action.scheduler.task.executions",
  "action.scheduler.task.backfill",
  "action.scheduler.task.export",
  "action.scheduler.task.import",
  "action.scheduler.status",
  "action.scheduler.statistics",
  "action.scheduler.upcoming",
  "action.scheduler.executions.recent",
  "action.scheduler.execution.get",
  "action.scheduler.event.trigger",
  "action.plan.step.dispatch",
  "action.skill.invoke",
  "action.skill.upsert",
  "action.twin.rag",
  "action.twin.ingest",
  "action.memory.recall",
  "action.memory.store",
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
  "action.git.stage",
  "action.git.commit",
  "action.git.push",
  "action.git.branch",
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
  "action.desktop.paste",
  "action.desktop.launchApp",
  "trigger.desktop.event",
  "action.system.terminal",
  "action.terminal.session.open",
  "action.terminal.session.run",
  "action.terminal.session.close",
  "action.terminal.script",
  "action.terminal.readRecent",
  "action.terminal.waitForExit",
  "trigger.terminal.command",
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
  "flow.break",
  "flow.continue",
  "flow.catch",
  "data.transform",
  "data.code",
  "data.template",
  "ocr.extract",
  "eval.run",
  "eval.gate",
  "io.http",
  "io.webhook.respond",
  "annotation.note",
  "annotation.group",
  "pattern.multi-modal-sweep",
  "pattern.loop-until-dry",
  "pattern.adversarial-verify",
  "pattern.judge-panel",
  "pattern.completeness-critic",
  "pattern.synthesize",
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
export type VisualWorkflowSchemaVersion = 1 | 2

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
  /**
   * Parent container node id (e.g. a `flow.loop` v2 container). Set on nodes
   * that live inside another node's sub-canvas; React Flow renders these with
   * `extent: 'parent'`. Undefined for top-level nodes. (schemaVersion 2)
   */
  parentId?: string
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
/**
 * Per-node error handling (n8n/Dify parity). Lives in node SETTINGS (not
 * params — kind-agnostic), purely additive: nodes without it keep the legacy
 * behavior (workflow-level `settings.errorPolicy`, workflow retryDefaults).
 */
export interface WorkflowNodeErrorHandling {
  /** Per-node retry override; absent → workflow `settings.retryDefaults`. */
  retry?: {
    /** Extra attempts after the first failure (0 = no retry). */
    maxRetries: number
    retryIntervalMs: number
    backoff: "fixed" | "exponential"
    /** Cap for exponential mode. */
    maxIntervalMs?: number
  }
  /**
   * What to do when the step ultimately fails (after retries):
   *  - "fail"        — legacy: defer to the workflow-level errorPolicy.
   *  - "continue"    — output `{ error }` and RUN downstream (n8n semantics).
   *  - "errorBranch" — route to edges leaving the node's "error" handle.
   *  - "defaultValue"— substitute `defaultValue` as the output, run downstream.
   */
  onError?: "fail" | "continue" | "errorBranch" | "defaultValue"
  /** Static output used when `onError === "defaultValue"`. */
  defaultValue?: unknown
  /**
   * Per-node circuit breaker. After `threshold` consecutive failures of this
   * (workflowId, nodeId) pair, the breaker opens: subsequent attempts
   * fail-fast with a non-retryable `CircuitOpenError` for `cooldownMs`,
   * routing through the same onError / error-edge path. A success resets the
   * counter. State is process-local (`lib/workflow/runtime/circuit-breaker.ts`).
   * Absent → no breaker.
   */
  circuitBreaker?: {
    /** Consecutive failures that trip the breaker (≥1). */
    threshold: number
    /** How long the breaker stays open before a half-open retry (ms). */
    cooldownMs: number
  }
}

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
  /** Per-node error handling; absent = legacy "fail" behavior. */
  errorHandling?: WorkflowNodeErrorHandling
  /**
   * Canvas lock: when true the node cannot be dragged or resized (React Flow
   * `draggable: false`). Purely an editor affordance — does not affect runs.
   * Carried explicitly through `reactFlowToWorkflow` (field-by-field rebuild).
   */
  locked?: boolean
}

export interface WorkflowEdge {
  id: string
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
  /** Optional label rendered on the edge (e.g., "true" / "false" for branch). */
  label?: string
  /** Optional author annotation on the connection (distinct from the label;
   * shown as a hover indicator on the canvas). Additive — no schema bump. */
  data?: { kind?: WorkflowEdgeKind; comment?: string }
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
  /**
   * Terminal-failure safety net. When a run fails terminally (retries
   * exhausted / errorPolicy resolves to stop with no handled branch):
   *  - `runCatchNodes` (default true): execute any `flow.catch` nodes + their
   *    downstream as a finalization phase before the run is marked failed.
   *  - `notify` (default false): append a `run_failed` NOTICE event so the UI
   *    can surface a toast / banner.
   * Absent → `{ runCatchNodes: true, notify: false }`.
   */
  onFailure?: {
    runCatchNodes?: boolean
    notify?: boolean
  }
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
  /**
   * Owning workspace id — Workspace isolation column (Dexie v86). Workflow
   * DEFINITIONS stay profile-shared; only their RUN history is per-project.
   * Stamped from the active project at run start. See `lib/db/project-scope.ts`.
   */
  projectId?: string
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
   * Small-model "work content" title summarising what this particular run did,
   * generated once on completion (see `lib/ai/generation/run-title-task.ts`).
   * Falls back to `workflowSnapshot.name` in the agent-runs view when absent.
   * Additive + non-indexed — no Dexie version bump.
   */
  title?: string
  /**
   * `true`/undefined while the run title is machine-managed; a manual rename
   * sets it `false` to opt out of (re)generation. Mirrors `ChatSession.titleAuto`.
   */
  titleAuto?: boolean
  /**
   * Origin metadata for runs whose `trigger.kind === "trigger.manual"` was
   * fired by an external surface (IM Claude tool, desktop button, HTTP API)
   * rather than the workflow's own trigger node. Drives IM-side progress
   * fan-out — see `lib/connectors/a2ui-bridge/workflow-progress-runner.ts`.
   */
  triggeredBy?: WorkflowTriggeredFrom
  /**
   * Denormalised copy of `triggeredBy.source` (Dexie v91), promoted to a
   * top-level INDEXED column because Dexie cannot index nested object props.
   * Lets `workflow-progress-runner` watch only IM-triggered runs via
   * `.where("triggeredBySource").equals("im")` instead of scanning the whole
   * `workflowRuns` table on every run. Stamped at run creation and backfilled
   * for legacy rows (`triggeredBy?.source ?? "ui"`).
   */
  triggeredBySource?: string
  /**
   * Dead-letter / replay metadata (A3). All additive + non-indexed (no Dexie
   * version bump): the dead-letter panel queries the existing `status` index
   * for `"failed"` rows.
   *  - `acknowledgedAt`: epoch ms a user dismissed this failure (hides it from
   *    the dead-letter list).
   *  - `replayedByRunId`: the run id spawned by the most recent replay.
   *  - `replayCount`: how many times this failed run has been replayed.
   */
  acknowledgedAt?: number
  replayedByRunId?: string
  replayCount?: number
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
  // Streaming LLM output chunks (throttled via stream-sink; payload
  // `{ delta, seq }`). Presentation-only — resume reads the final output
  // from `step_completed`, never reassembles chunks.
  | "step_stream"
  // Token/cost usage snapshot for one step (payload = StepUsage).
  | "step_usage"
  // Emitted before each retry backoff wait (payload
  // `{ attempt, maxAttempts, delayMs, error }`).
  | "step_retrying"

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
 * Token/cost usage reported by an LLM-backed step. Persisted as the payload
 * of a `step_usage` event; aggregated per-run by the Runs UI.
 */
export interface StepUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Prompt-cache READ tokens (billed at a discount). Absent ⇒ 0. */
  cacheReadTokens?: number
  /** Prompt-cache WRITE/creation tokens (billed at a premium). Absent ⇒ 0. */
  cacheCreationTokens?: number
  /** Provider that actually served the call (post-routing/fallback). */
  providerId?: string
  modelId?: string
  /** Estimated USD cost; undefined when no pricing is known for the model. */
  costUsd?: number
}

/**
 * Per-step execution context. The runtime constructs one of these per
 * `(runId, stepId)` pair and passes it to the registered NodeExecutor.
 */
export interface StepExecutionContext<TParams = Record<string, unknown>> {
  runId: string
  workflowId: string
  stepId: string
  /**
   * Optional run-scoped agent-trace id. When set (e.g. by the eval workflow
   * target), AI nodes emit their LLM spans under this trace so the run can be
   * assembled via `queryByTrace`. Undefined for normal runs.
   */
  traceId?: string
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
  /**
   * Push one streaming output delta (LLM token chunk). Buffered/throttled by
   * the runtime's stream sink before landing as `step_stream` events, so
   * executors may call this per token without write amplification. Absent
   * when the run surface doesn't render live output.
   */
  emitStream?: (delta: string) => void
  /**
   * Report token/cost usage for this step. Lands as a `step_usage` event;
   * call at most once, after the LLM call settles.
   */
  reportUsage?: (usage: StepUsage) => void
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
   * True when the workflow contains an `io.webhook.respond` node — the Rust
   * receiver then holds the inbound request open for a dynamic response
   * instead of replying with the static body immediately.
   */
  webhookAwaitResponse?: boolean
  /**
   * How long (ms) to hold an `await_response` request before falling back to
   * the static response. Absent / 0 = the Rust default (~25s).
   */
  webhookResponseTimeoutMs?: number
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
  // In-run ready-set parallelism for NEW workflows. Persisted workflows
  // without the field keep the legacy sequential behavior (`?? 1` in
  // runWorkflow) — only the seed for newly created workflows changed.
  maxConcurrency: 4,
  retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
  onFailure: { runCatchNodes: true, notify: false },
}

export const DEFAULT_RETRY_POLICY: WorkflowRetryPolicy = {
  attempts: 3,
  backoff: "exponential",
  baseMs: 1000,
  maxMs: 30_000,
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor-only NDV (node data view) shapes. These are NOT persisted and NOT part
// of the wire format — they are derived at render time by
// `lib/workflow/editor/node-io-data.ts` from the latest run's `step_completed`
// payloads overlaid with `VisualWorkflow.pinData`. Kept here so the resolver and
// its UI consumers share one definition (project rule: types live in `types/`).
// ─────────────────────────────────────────────────────────────────────────────

/** Where a piece of NDV data came from. `pin` wins over `run`; `none` = absent. */
export type NodeIoSource = "pin" | "run" | "none"

/** The selected node's resolved output for the Output tab. */
export interface NodeIoOutput {
  value: unknown
  /** True when the value came from `pinData` rather than a real run. */
  pinned: boolean
  source: NodeIoSource
}

/** One upstream node's contribution to the selected node's Input tab. */
export interface NodeIoInputEntry {
  upstreamNodeId: string
  upstreamLabel: string
  value: unknown
  source: NodeIoSource
}

/** Resolved input + output data for a single node, for the inspector NDV tabs. */
export interface NodeIoData {
  output: NodeIoOutput
  inputs: NodeIoInputEntry[]
}

/** Primitive/structural type tag used by the Schema view + drag-to-map rows. */
export type SchemaRowType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "undefined"

/**
 * One row of the Schema view — a flattened path into a node's output object.
 * `segments` is the structured accessor (e.g. `["items", 0, "id"]`) used to
 * build a node reference expression; `path` is its human display form
 * (e.g. `items[0].id`); `sample` is a short string preview of the value at
 * that path. Produced by `flattenSchema`.
 *
 * NOTE: there is intentionally NO `.out` wrapper — paths address the node's
 * raw output object exactly as the runtime stores it (`upstream[id]`), so a
 * dragged reference resolves correctly. See `lib/workflow/editor/expr-ref.ts`.
 */
export interface SchemaRow {
  segments: Array<string | number>
  path: string
  type: SchemaRowType
  sample: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-level palette taxonomy (schemaVersion 2). The top-level
// `WorkflowNodeCategory` is derived from the kind prefix; `subcategory` is
// author-supplied catalog metadata (see `lib/workflow/nodes/catalog.ts`).
// Kept as a string (not a closed union) so plugin-contributed nodes can
// introduce their own subcategory without a type change. Known built-in
// values are listed in `BUILTIN_NODE_SUBCATEGORIES`.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowNodeSubcategory = string

export const BUILTIN_NODE_SUBCATEGORIES = [
  "github",
  "desktop",
  "agent",
  "connectors",
  "logic",
  "loops",
  "parallel",
  "data",
  "io",
  "ai",
  "triggers",
  "system",
  "twin",
  "skills",
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Loop container params (flow.loop typeVersion 2). The legacy typeVersion 1
// flat-transform params shape is untyped (Record<string, unknown>) and stays
// valid — this type describes only the new container authoring.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopNodeParams {
  mode: "forEach" | "times" | "while"
  /** forEach: expression resolving to an array to iterate. */
  source?: string
  /** times: iteration count (literal or expression). */
  times?: number | string
  /** while: per-iteration boolean expression, re-evaluated each round. */
  whileExpression?: string
  /**
   * while only — when the condition is checked relative to the body.
   * `"pre"` (default) is a classic while; `"post"` runs the body first and
   * checks AFTER each round (do-while: at least one iteration). Both timings
   * continue while truthy.
   */
  conditionTiming?: "pre" | "post"
  /**
   * Expression evaluated at the END of each iteration; its result is pushed
   * into the loop's `items[]` output. `$item`/`$loop` are in scope. When
   * omitted, the iteration index is collected instead.
   */
  output?: string
  /**
   * Max concurrent iterations for forEach/times. Default 1 (sequential).
   * Bounded at run time by the shared global in-flight gate.
   */
  iterationConcurrency?: number
  /**
   * forEach only — groups the source into sequential batches of this size
   * (n8n SplitInBatches semantics). Items INSIDE a batch still parallelize up
   * to `iterationConcurrency`; the next batch starts only when the previous
   * one fully drains. Unset/0 → one implicit batch (today's behavior).
   */
  batchSize?: number
  /** Hard cap on total iterations (defends against runaway while-loops). */
  maxIterations?: number
  /**
   * Container-level backstop for iteration errors that the child's own
   * error handling (errorBranch / continue / defaultValue) did NOT absorb:
   * `"fail"` (default) rejects the container — today's behavior;
   * `"skip"` records the failure in `output.errors[]` and keeps looping;
   * `"break"` records it and stops the loop with partial output.
   */
  onItemError?: "fail" | "skip" | "break"
}

/** One failed iteration collected by `onItemError: "skip" | "break"`. */
export interface LoopItemError {
  /** Global iteration index (source order). */
  index: number
  /** The forEach item, when applicable (undefined for times/while). */
  item?: unknown
  error: string
  errorType?: string
}
