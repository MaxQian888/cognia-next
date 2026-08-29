/**
 * Visual workflows — n8n-style graph orchestration over cognia-next runtime
 * entities (Characters, Agent Teams, Skills, Twins, Connectors, MCP, Plugins).
 *
 * NOT to be confused with the existing `./workflow.ts` — that file is the
 * higher-level WorkflowType / WorkflowDefinition system used by PPT
 * generation. This file is the data model for the visual graph editor and
 * its execution engine.
 *
 * Dexie schema v156 backs the definition, immutable deployment, execution,
 * event-log, and durable checkpoint planes. The core workflow tables are:
 *
 *   • `workflows`         — visual workflow definitions (graph + settings)
 *   • `workflowRuns`      — one row per execution (status, frozen snapshot)
 *   • `workflowRunEvents` — durable per-step event log (live-queried by UI)
 *   • `workflowTriggers`  — registered triggers (cron, webhook, inbound, ...)
 *   • `workflowVersions` / `workflowDeployments` / `workflowInvocations`
 *                         — immutable production authority and admission ledger
 *   • `workflowWaitpoints` / `workflowWaitEvents`
 *                         — CAS-controlled HITL/risk/event checkpoints
 *
 * The hybrid runtime split (Rust triggers + TS orchestration) is documented in
 * `docs/content/docs/adr/0011-workflows-subsystem.md`. The shapes here are the
 * wire format for both the editor (TS-only) and the IPC contract (TS ↔ Rust).
 */

import type { PlacementConstraint } from "@/lib/placement/types"

// ─────────────────────────────────────────────────────────────────────────────
// Node taxonomy. Namespaced as `<group>.<kind>` so plugin-contributed nodes
// can use their own prefix (e.g., `myplugin.action.foo`) without colliding.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowNodeKind =
  // Triggers
  | "trigger.manual"
  | "trigger.cron"
  | "trigger.connector.inbound"
  // Non-message platform events (reaction added/removed, poke, request,
  // lifecycle) surfaced by the connector bus's `applySystemEvent`.
  | "trigger.connector.system"
  | "trigger.chat.message"
  | "trigger.webhook"
  | "trigger.integration.event"
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
  // Blocking lead review of a task's work (ADR-0071). Synthesizer-emitted only,
  // never placed by users in the editor.
  | "action.team.task.review"
  | "action.team.reconcile"
  // Agent-team surface exposure (multi-bot orchestration): auto-compose a
  // team from an objective, query team state/results mid-workflow, delegate
  // to twin/background/external/team, and post into the team blackboard.
  | "action.team.compose"
  | "action.team.status"
  | "action.team.delegate"
  | "action.team.message"
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
  // Workflow-native knowledge production stages. Content-bearing handoffs
  // use encrypted run-scoped artifacts rather than workflow event payloads.
  | "knowledge.source"
  | "knowledge.parse"
  | "knowledge.transform"
  | "knowledge.chunk"
  | "knowledge.embed"
  | "knowledge.index"
  | "knowledge.publish"
  | "knowledge.retrieve"
  // Autonomous long-term memory (lib/memory): hybrid recall + explicit store.
  | "action.memory.recall"
  | "action.memory.store"
  | "action.connector.send"
  | "action.connector.draft"
  // Fine-grained connector feedback ops (multi-bot round 3): react to /
  // delete a platform message by id, and block until a reply arrives in a
  // conversation (the workflow-side feedback loop for IM sends).
  | "action.connector.reaction"
  | "action.connector.delete"
  // Forward / merge-forward an existing message to another conversation.
  | "action.connector.forward"
  | "action.connector.waitReply"
  // Human-in-the-loop gate (ADR 0061 P2): blocks until a human approves or
  // rejects — desktop notification action, or a paired device via the
  // `workflow_approval_respond` RPC. Routes downstream via decision handles.
  | "action.approval.request"
  // Durable multi-field, multi-action Human Input with any/all/quorum assignees.
  | "action.humanInput.request"
  // Remote device steps (ADR 0061 P3): hub-side proxy executors dispatch to
  // a capable paired device via the remote-step broker and marshal the
  // device's output back into the run.
  | "action.mobile.camera"
  | "action.mobile.scanBarcode"
  | "action.mobile.location"
  | "action.mobile.share"
  | "action.mobile.notify"
  | "action.mcp.invokeTool"
  | "action.plugin.invoke"
  // Local Git (Source Control panel backend — ADR-0038)
  | "action.git.stage"
  | "action.git.commit"
  | "action.site.build"
  | "action.site.deploy"
  | "action.site.rollback"
  | "action.site.status"
  | "action.git.push"
  | "action.git.branch"
  // Stacked branches (ADR — stacks as first-class). Local git only: publishing
  // and merging a stack talks to a forge, which stays plugin territory.
  | "action.stack.list"
  | "action.stack.parent"
  | "action.stack.validate"
  | "action.stack.restack"
  | "action.stack.push"
  // Embedded code-server "Pro IDE" (ADR-0088 Phase 3). Addressing mirrors
  // `action.git.*`: an explicit `root`, else the bound Pro IDE, else a throw.
  | "action.editor.open"
  | "action.editor.reveal"
  | "action.editor.showDiff"
  | "action.editor.readActive"
  | "action.editor.applyEdit"
  | "action.editor.saveAll"
  // Desktop UI automation (provided by the automation subsystem — see
  // `docs/superpowers/specs/2026-05-12-ui-automation-subsystem-design.md`)
  | "action.desktop.listApps"
  | "action.desktop.getAppState"
  | "action.desktop.queryElements"
  | "action.desktop.expandElement"
  | "action.desktop.performAction"
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
  // Desktop-pet lifecycle trigger (levelUp/evolved/achievementUnlocked/unwell)
  // + nurture action. Runner lives in `lib/workflow/runtime/pet-event-trigger.ts`.
  | "trigger.pet.event"
  | "action.pet.interact"
  // Chained workflows (ADR-0081): fires when another workflow's run reaches a
  // terminal status (succeeded/failed). Emitted by the orchestrator through
  // `lib/workflow/runtime/workflow-completion-fanout.ts` with a chain-depth
  // guard + self-trigger protection, consumed via the TS-hook trigger index.
  | "trigger.workflow.completed"
  // AI primitives
  | "ai.prompt"
  | "ai.classify"
  | "ai.extract"
  | "ai.embed"
  | "ai.browserModel"
  | "ai.council"
  | "ai.ensemble"
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
  | "data.aggregate"
  | "data.code"
  | "data.template"
  | "ocr.extract"
  // Eval (agent evaluation engine)
  | "eval.run"
  | "eval.gate"
  // I/O
  | "io.http"
  | "io.webhook.respond"
  | "io.output"
  | "io.answer"
  | "io.webClone"
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
  "trigger" | "action" | "ai" | "flow" | "data" | "io" | "annotation"

export function workflowNodeCategory(kind: WorkflowNodeKind): WorkflowNodeCategory {
  const head = kind.split(".")[0]
  if (head === "trigger") return "trigger"
  if (head === "action") return "action"
  if (head === "ai") return "ai"
  if (head === "flow") return "flow"
  if (head === "data") return "data"
  if (head === "knowledge") return "data"
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
  "trigger.connector.system",
  "trigger.chat.message",
  "trigger.webhook",
  "trigger.integration.event",
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
  "action.team.task.review",
  "action.team.reconcile",
  "action.plan.create",
  "action.plan.get",
  "action.plan.list",
  "action.plan.events",
  "action.plan.updateDraft",
  "action.plan.approve",
  "action.team.compose",
  "action.team.status",
  "action.team.delegate",
  "action.team.message",
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
  "knowledge.source",
  "knowledge.parse",
  "knowledge.transform",
  "knowledge.chunk",
  "knowledge.embed",
  "knowledge.index",
  "knowledge.publish",
  "knowledge.retrieve",
  "action.memory.recall",
  "action.memory.store",
  "action.connector.send",
  "action.connector.draft",
  "action.approval.request",
  "action.humanInput.request",
  "action.mobile.camera",
  "action.mobile.scanBarcode",
  "action.mobile.location",
  "action.mobile.share",
  "action.mobile.notify",
  "action.connector.reaction",
  "action.connector.delete",
  "action.connector.forward",
  "action.connector.waitReply",
  "action.mcp.invokeTool",
  "action.plugin.invoke",
  "action.git.stage",
  "action.git.commit",
  "action.site.build",
  "action.site.deploy",
  "action.site.rollback",
  "action.site.status",
  "action.git.push",
  "action.git.branch",
  "action.stack.list",
  "action.stack.parent",
  "action.stack.validate",
  "action.stack.restack",
  "action.stack.push",
  "action.editor.open",
  "action.editor.reveal",
  "action.editor.showDiff",
  "action.editor.readActive",
  "action.editor.applyEdit",
  "action.editor.saveAll",
  "action.desktop.listApps",
  "action.desktop.getAppState",
  "action.desktop.queryElements",
  "action.desktop.expandElement",
  "action.desktop.performAction",
  "trigger.desktop.event",
  "action.system.terminal",
  "action.terminal.session.open",
  "action.terminal.session.run",
  "action.terminal.session.close",
  "action.terminal.script",
  "action.terminal.readRecent",
  "action.terminal.waitForExit",
  "trigger.terminal.command",
  "trigger.pet.event",
  "action.pet.interact",
  "trigger.workflow.completed",
  "ai.prompt",
  "ai.classify",
  "ai.extract",
  "ai.embed",
  "ai.browserModel",
  "ai.council",
  "ai.ensemble",
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
  "data.aggregate",
  "data.code",
  "data.template",
  "ocr.extract",
  "eval.run",
  "eval.gate",
  "io.http",
  "io.webhook.respond",
  "io.output",
  "io.answer",
  "io.webClone",
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
  /** Reusable Knowledge Bases queried when this workflow runs. */
  knowledgeBaseIds?: string[]
  /** UI-only test data pinned per node so the inspector can replay outputs. */
  pinData?: Record<string, unknown>
  /** Cross-run mutable state. Persisted on the workflow row, not snapshots. */
  staticData?: Record<string, unknown>
  /** Last saved canvas viewport so reopening lands the user where they were. */
  viewport?: WorkflowViewport
  /**
   * Declared call interface (D5). When present the workflow can be published as
   * a typed callable unit — an agent tool, a typed `flow.subworkflow` target,
   * and a skill-catalog entry. Stored as serializable JSON Schemas; the canvas
   * `trigger.manual` input + `io.output` node edit them. Interface (schema) is
   * declared separately from implementation (the graph).
   */
  interface?: WorkflowInterface
  /** Set when the workflow has been published as a callable unit. */
  published?: WorkflowPublication
}

/** Typed input/output contract a published workflow exposes to callers. */
export interface WorkflowInterface {
  /** JSON object schema for the run payload (surfaces as `$trigger.payload`). */
  inputSchema?: Record<string, unknown>
  /** JSON object schema the terminal output must satisfy. */
  outputSchema?: Record<string, unknown>
}

/** Publication record: registers the 3 call surfaces (tool / subworkflow / skill). */
export interface WorkflowPublication {
  at: number
  /** Display-only slug; execution always uses the shared typed workflow runner. */
  toolName: string
  /** Immutable artifact selected by the production deployment. */
  versionId?: string
  /** Stable production deployment pointer. Optional only during legacy migration. */
  deploymentId?: string
  /** Revision of the pointer when this projection was written. */
  deploymentRevision?: number
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
  /**
   * Placement for top-level asynchronous invocations. Legacy definitions omit
   * the field and validate to `colocate`, preserving the pre-placement runtime.
   */
  runOn?: PlacementConstraint
  /**
   * Auto-gate medium/high-risk nodes behind an approval wait (ADR-0070 Phase 3).
   *
   * Unlike `AgentTeamConfig.riskGating` and `GoalConfig.riskGating`, this is
   * **opt-in**: `undefined` means OFF. A workflow authored before ADR-0070 has
   * no field, and turning gating on retroactively would start pausing
   * (interactive) or failing (headless) automations users already rely on.
   * `createWorkflow` stamps `true` on newly created workflows, so new work is
   * gated and existing work is left exactly as it was.
   */
  riskGating?: boolean
  /** Hard ceiling on a single run's wall-clock time. */
  timeoutMs: number
  /** How many runs of THIS workflow may execute concurrently. */
  concurrency: number
  /**
   * Per ADR-0022 §3.7. Max in-flight nodes WITHIN a single run for the
   * ready-set scheduler. Optional; absent values are backfilled to
   * {@link DEFAULT_MAX_CONCURRENCY} by the zod settings schema, so the
   * orchestrator, the editor forms, and new-workflow seeds all agree on ONE
   * default. NOT the same as `concurrency` (that field caps concurrent RUNS
   * of the same workflow).
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
  "pending" | "running" | "waiting" | "paused" | "succeeded" | "failed" | "cancelled"

/**
 * Trigger envelope — produced by triggers (manual button, cron daemon, webhook
 * receiver, connector inbound tap, chat-message hook). The orchestrator
 * accepts any TriggerEvent and decides whether to fan-out via a graph node.
 */
export interface TriggerEvent {
  workflowId: string
  /** Which trigger node kind produced this event. */
  kind: WorkflowNodeKind
  /** Exact workflow trigger-node id that produced this event. */
  triggerId?: string
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
  /** Platform-native inbound message id used to anchor thread-native run streams. */
  sourceMessageId?: string
  conversationKey?: string
  characterId?: string
  /** Scopes a `trigger.goal.completed` subscription to a specific goal id. */
  goalId?: string
  /** Scopes a `trigger.team` subscription to a specific team id. */
  teamId?: string
}

/**
 * Origin of a run that did NOT come from the workflow's own trigger node.
 * Today this means a Claude tool invocation (`wf_run_workflow_by_name`) fired
 * from an IM session, or a desktop UI button, or an HTTP API call. Distinct
 * from `WorkflowTriggerBinding` (which describes the trigger node payload):
 * a manual run from IM has `triggerKind: "trigger.manual"` AND
 * `triggeredBy.source: "im"`. The execution bridge mirrors such runs into
 * `executionRuns` and the run-presentation runner projects them back to
 * `triggeredBy.conversationKey` through the governed outbound queue.
 */
export interface WorkflowTriggeredFrom {
  /**
   * `"chat"` = the main chat `/workflow` slash command; `"desktop"` = the
   * library card Run button. Both are surfaced by the global run-progress
   * toaster (`"ui"` — editor/run-list — keeps its own inline toasts).
   * `"schedule"` = a `workflow` scheduled task fired by the app scheduler
   * (`lib/scheduler/executors/workflow-executor.ts`); run history can then
   * tell a timed run from a human-initiated one.
   */
  source: "im" | "ui" | "api" | "chat" | "desktop" | "schedule"
  adapterId?: string
  conversationKey?: string
  sourceMessageId?: string
  deliveryTarget?: import("@/types/connectors/event").ConversationDeliveryTarget
  sessionId?: string
  /** Run-scoped persona reference supplied by an IM conversation binding. */
  characterId?: string
  initiator?: {
    platformIdentityId?: string
    remoteUserId?: string
    displayName?: string
    /** Resolved principal/account stamp — see `ExecutionRunInitiator`. */
    principalId?: string
    accountId?: string
    /** True only when the request surface verified an OIDC member. */
    authenticated?: boolean
    /** Verified OIDC groups captured at admission for document ACL evaluation. */
    groupIds?: string[]
    /** App-local ownership key; never grants document permissions. */
    externalSubjectKey?: string
  }
  /**
   * Paired-device id of the companion caller (ADR-0060). Stamped server-side
   * from the verified device JWT — never client-supplied — so run history and
   * audit surfaces can answer "which device triggered this". Absent for runs
   * originating on the desktop itself.
   */
  deviceId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Dexie row shapes (what `lib/db/schema.ts` v22 stores).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `workflows` table row. Identical shape to `VisualWorkflow` — kept as
 * its own alias so callers reading the table can grep for the row type.
 */
export type WorkflowRow = VisualWorkflow

/**
 * Execution lease (ADR 0061 P4). Exactly one executor process may drive a
 * run: the lease is claimed before the first step and heartbeat-renewed
 * while the run is live, so a second process (crash-resume race, a future
 * cloud brain) backs off instead of double-executing. Additive +
 * non-indexed — no Dexie version bump.
 */
export interface WorkflowRunLease {
  /** Per-process executor id (`lib/workflow/runtime/run-lease.ts`). */
  ownerId: string
  claimedAt: number
  /** Epoch ms; a lease past this is stale and free to claim. */
  expiresAt: number
}

export type WorkflowRetryMode = "original-version" | "current-deployment" | "failed-step"

/** Author-selected policy at a workflow egress boundary. */
export type WorkflowPiiGateMode = "off" | "block" | "redact"

/** Boundary classes covered by the workflow PII egress policy. */
export type WorkflowEgressSink = "model" | "connector" | "remote-tool" | "local-tool"

/** Immutable relationship metadata shared by nested and retried runs. */
export interface WorkflowRunLineage {
  rootRunId: string
  parentRunId?: string
  parentStepId?: string
  retryOfRunId?: string
  retryMode?: WorkflowRetryMode
}

/** Security provenance that must survive subflows and crash recovery. */
export interface WorkflowRunSecurityContext {
  piiEgressRequired: boolean
  sourceTriggerKind: WorkflowNodeKind
  /**
   * Parent IM ceiling for dynamic agent turns. Fixed workflow nodes retain
   * their deployment and node-level security policy.
   */
  permissionCeiling?: import("@/types/agent/permission-ceiling").AgentPermissionCeiling
}

export interface WorkflowRunRow {
  id: string
  workflowId: string
  /** Immutable artifact used for this formal invocation. */
  versionId?: string
  /** Deployment pointer resolved before the run was admitted. */
  deploymentId?: string
  deploymentRevision?: number
  /** Formal ingress provenance; draft/editor runs intentionally omit it. */
  executionBinding?: import("./deployment").WorkflowExecutionBinding
  /** New runs always carry a W3C-compatible 128-bit trace id; legacy rows may omit it. */
  traceId?: string
  /** First-class parent/retry relationship; legacy rows may omit it. */
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /** Immutable child workflow/index versions resolved before formal admission. */
  dependencyLock?: import("./deployment").WorkflowDependencyLock
  /**
   * Owning workspace id — Workspace isolation column (Dexie v86). Workflow
   * DEFINITIONS stay profile-shared; only their RUN history is per-project.
   * Stamped from the active project at run start. See `lib/db/project-scope.ts`.
   */
  projectId?: string
  status: RunStatus
  /** Which trigger kind started this run. */
  triggerKind: WorkflowNodeKind
  /** Exact trigger-node id, when the producer identified one. */
  triggerId?: string
  triggerPayload: unknown
  triggerBinding?: WorkflowTriggerBinding
  /** Original producer timestamp; distinct from local run admission time. */
  triggerOriginAt?: number
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
   * fan-out — see `lib/execution/workflow-bridge.ts` and
   * `lib/connectors/run-presentation/runner.ts`.
   */
  triggeredBy?: WorkflowTriggeredFrom
  /**
   * Denormalised copy of `triggeredBy.source` (Dexie v91), promoted to a
   * top-level INDEXED column because Dexie cannot index nested object props.
   * Lets IM-scoped readers (`lib/workflow/runtime/risk-gate.ts`,
   * `execution-authority.ts`) watch only IM-triggered runs via
   * `.where("triggeredBySource").equals("im")` instead of scanning the whole
   * `workflowRuns` table on every run. Stamped at run creation and backfilled
   * for legacy rows (`triggeredBy?.source ?? "ui"`).
   */
  triggeredBySource?: string
  /** Execution lease (ADR 0061 P4) — see {@link WorkflowRunLease}. */
  lease?: WorkflowRunLease
  /**
   * Epoch ms when a cancel was requested by a surface that could NOT abort
   * the run locally (the lease is held by another live executor). The lease
   * owner's heartbeat observes this and aborts. Additive + non-indexed.
   */
  cancelRequestedAt?: number
  /**
   * Epoch ms this run's executor released its lease on the way out.
   *
   * A desktop quitting mid-run used to leave a live lease behind, so the run
   * stayed unclaimable for the rest of the lease TTL even though its executor
   * was demonstrably gone. Stamping the release makes the handoff explicit —
   * whoever picks the run up can tell "the previous host stood down" from "the
   * previous host vanished", which are different stories in an audit.
   */
  releasedForHandoffAt?: number
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
  // User-visible agent narration, kept separate from model reasoning and
  // coalesced by the runtime before presentation.
  | "step_commentary"
  // Token/cost usage snapshot for one step (payload = StepUsage).
  | "step_usage"
  // Emitted before each retry backoff wait (payload
  // `{ attempt, maxAttempts, delayMs, error }`).
  | "step_retrying"

export type RunEventLogLevel = "debug" | "info" | "warn" | "error"

export interface WorkflowRunEventRow {
  id: string
  runId: string
  /** Durable per-run cursor. Present on v145+ rows; migration backfills history. */
  sequence?: number
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
  /** IANA timezone used for cron wall-clock evaluation; absent means host local. */
  timezone?: string
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
  /** Loop-container provenance for this concrete step execution. */
  iteration?: { loopId: string; iterationIndex: number }
  /** Formal run provenance, including the pre-admission dependency lock. */
  executionBinding?: import("./deployment").WorkflowExecutionBinding
  /** Parent/retry provenance shared with nested node executors. */
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /**
   * The workspace this run belongs to, stamped from the active project when the
   * run was admitted (the same value as `WorkflowRunRow.projectId`).
   *
   * Threaded onto the step so an executor that needs a directory can ask the
   * run rather than a UI store. A scheduled or headless run has no open panel,
   * so a store read there is not a fallback — it is an empty value dressed up
   * as one.
   */
  projectId?: string
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
   * Push user-visible mid-turn agent narration. This is distinct from
   * `emitStream` (the final answer) and never carries raw model analysis.
   */
  emitCommentary?: (delta: string) => void
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
  /** IANA timezone used by the Rust cron daemon; absent means host local. */
  timezone?: string
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
  binding?: WorkflowTriggerBinding
  enabled: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — the editor and seed loaders use these when creating new entities.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONE in-run ready-set parallelism default. Four sources used to disagree
 * (zod: none, seed: 4, orchestrator: 1, editor: 1/4) — making the same
 * workflow sequential or 4-wide depending on whether its persisted `settings`
 * blob happened to carry the field. Every consumer now derives from this
 * constant: the zod settings schema backfills it at validation, so legacy
 * no-field workflows run 4-wide like new ones.
 */
export const DEFAULT_MAX_CONCURRENCY = 4

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  errorPolicy: "stop",
  runOn: { mode: "colocate" },
  timeoutMs: 600_000,
  concurrency: 1,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
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
  "string" | "number" | "boolean" | "object" | "array" | "null" | "undefined"

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
   * `"continue-with-null"` preserves source alignment with a `null` item;
   * `"remove-failed"` records the failure and compacts it from `items[]`;
   * `"break"` records it and stops the loop with partial output.
   * `"skip"` is the legacy serialized alias for `"remove-failed"`.
   */
  onItemError?: "fail" | "continue-with-null" | "remove-failed" | "break" | "skip"
}

/** One failed iteration collected by any non-failing `onItemError` policy. */
export interface LoopItemError {
  /** Global iteration index (source order). */
  index: number
  /** The forEach item, when applicable (undefined for times/while). */
  item?: unknown
  error: string
  errorType?: string
}
