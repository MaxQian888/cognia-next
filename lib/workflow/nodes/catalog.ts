/**
 * Node catalog — shared metadata for every WorkflowNodeKind. Drives the
 * search sidebar, command palette, inspector header, and (eventually) the
 * marketplace template tab.
 *
 * Lives in `lib/workflow/nodes/` rather than `components/` so non-component
 * consumers (the orchestrator, validators, the JSON importer) can read the
 * metadata without pulling in React.
 */

import {
  WORKFLOW_NODE_KINDS,
  workflowNodeCategory,
  type WorkflowNodeCategory,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"
import type { CapabilityId } from "@/lib/platform/capabilities"

export interface NodeCatalogEntry {
  kind: WorkflowNodeKind
  /** Current authoring version for plugin-contributed kinds. */
  typeVersion?: number
  category: WorkflowNodeCategory | "plugin"
  /** Short label shown in the sidebar / palette. */
  label: string
  /** One-line description shown in the search sidebar tooltip + palette. */
  description: string
  /** Lucide icon name (resolved by the renderer). */
  iconName: string
  /** Free-form keywords used by the palette's fuzzy search. */
  keywords: string[]
  /** True if the node should NOT appear in user-facing pickers (e.g., legacy). */
  hidden?: boolean
  /** True if the node only fires on Tauri (web-mode hides them). */
  desktopOnly?: boolean
  /**
   * Platform capabilities the node's executor needs at run time (ADR 0060).
   * Checked by the orchestrator's capability preflight against
   * `detectLocalCapabilities()`; surfaced as an affinity badge in the editor.
   * Absent = runs anywhere the webview runs (unless `desktopOnly` — see
   * {@link effectiveRequires}).
   */
  requires?: readonly CapabilityId[]
  /**
   * True if the node is authored but not yet driven by a real runtime
   * producer — authors can drop it on a canvas but it will only fire in
   * manual mode, never from the real event it advertises. The editor should
   * badge these so users aren't misled into building workflows that never run.
   */
  experimental?: boolean
  /**
   * Set on plugin-contributed entries; absent for built-ins. Used by the
   * sidebar to render a per-plugin sub-group inside the "Plugin nodes"
   * section.
   */
  pluginId?: string
  /**
   * Optional JSON Schema describing the node's params. Set for plugin
   * entries that ship a `paramsSchema`; used by the inspector to render an
   * auto-generated `SchemaForm` instead of the raw-JSON fallback.
   */
  paramsSchema?: Record<string, unknown>
  /**
   * Params inserted when a node is dropped from the palette. Built-ins use
   * code defaults; plugin entries carry their `PluginNodeDef.defaultParams`
   * or `PluginTriggerDef.defaultParams` here so the editor can preserve the
   * author-provided starter config without knowing plugin internals.
   */
  defaultParams?: Record<string, unknown>
}

// `Partial` because not every `WorkflowNodeKind` ships palette metadata: some
// kinds exist for the runtime/registry only (e.g. the agent-team `pattern.*`
// orchestration kinds) and have no inspector/catalog presence. Consumers
// (`groupedCatalog`, `searchCatalog`, `nodeCatalogEntry`) already tolerate a
// missing entry, so this type just stops the table from being forced to list
// kinds it doesn't describe.
const ENTRIES: Partial<Record<WorkflowNodeKind, Omit<NodeCatalogEntry, "kind" | "category">>> = {
  // ── Triggers ──────────────────────────────────────────────────────────────
  "trigger.manual": {
    label: "Run manually",
    description: "Fires when you click Run in the editor.",
    iconName: "Play",
    keywords: ["manual", "run", "start"],
  },
  "trigger.cron": {
    label: "On schedule",
    description: "Fires on a cron schedule. Backed by the Tauri scheduler when running.",
    iconName: "Clock",
    keywords: ["cron", "schedule", "interval", "every", "timer"],
  },
  "trigger.connector.inbound": {
    label: "Incoming message",
    description: "Fires when a message arrives on a connected platform (Telegram, Slack, ...).",
    iconName: "Inbox",
    keywords: ["telegram", "slack", "discord", "lark", "onebot", "platform", "message", "inbound"],
  },
  "trigger.connector.system": {
    label: "On platform event",
    description:
      "Fires on non-message platform events — reactions, pokes, join requests, bot lifecycle — from a connected platform.",
    iconName: "Bell",
    keywords: ["reaction", "emoji", "poke", "request", "lifecycle", "platform", "system", "event"],
  },
  "trigger.chat.message": {
    label: "On chat message",
    description: "Fires when a user sends a message in a bound character session.",
    iconName: "MessageSquare",
    keywords: ["chat", "user", "message", "session"],
  },
  "trigger.goal.completed": {
    label: "On goal completed",
    description:
      "Fires when a /goal reaches a terminal status (completed, stopped, budget/turn/timeout).",
    iconName: "Target",
    keywords: ["goal", "objective", "completed", "done", "finished", "loop"],
  },
  "trigger.workflow.completed": {
    label: "On workflow completed",
    description:
      "Fires when another workflow's run finishes (succeeded or failed), receiving its output as the trigger payload. Chain-depth guarded; a workflow can never trigger itself.",
    iconName: "Workflow",
    keywords: ["workflow", "chain", "completed", "finished", "pipeline", "then", "after"],
  },
  "trigger.pet.event": {
    label: "On pet event",
    description:
      "Fires when the desktop pet levels up, evolves, unlocks an achievement, or becomes unwell.",
    iconName: "PawPrint",
    keywords: ["pet", "level", "evolve", "achievement", "unwell", "mascot"],
  },
  "action.pet.interact": {
    label: "Nurture pet",
    description:
      "Feed / play with / clean the desktop pet (optionally consuming a shop item by id).",
    iconName: "PawPrint",
    keywords: ["pet", "feed", "play", "nurture", "care", "mascot"],
  },
  "trigger.webhook": {
    label: "On webhook",
    description: "Fires when an HTTP request hits the workflow's webhook path.",
    iconName: "Webhook",
    keywords: ["webhook", "http", "post", "endpoint"],
    desktopOnly: true,
    requires: ["always-on"],
  },
  "trigger.integration.event": {
    label: "On integration event",
    description: "Fires when an installed Marketplace integration publishes a normalized event.",
    iconName: "PlugZap",
    keywords: ["integration", "marketplace", "event", "repository", "workspace"],
    desktopOnly: true,
    requires: ["always-on"],
  },
  "trigger.team": {
    label: "On team finished",
    description:
      "Fires when an agent-team run reaches a terminal status (completed / failed / cancelled). Optionally scope by team and status. The kind doubles as the internal marker the team synthesizer stamps on its own runs.",
    iconName: "Users",
    keywords: ["team", "finished", "completed", "agent team"],
  },
  // ── Actions ───────────────────────────────────────────────────────────────
  "action.character.send": {
    label: "Send as character",
    description: "Sends a message as a chosen character into a session.",
    iconName: "Send",
    keywords: ["send", "character", "persona", "reply"],
  },
  "action.character.create": {
    label: "Create character",
    description: "Creates a new character (employee) row.",
    iconName: "UserPlus",
    keywords: ["new", "create", "character", "persona", "employee"],
  },
  "action.character.update": {
    label: "Update character",
    description: "Patches fields on an existing character.",
    iconName: "UserCog",
    keywords: ["update", "edit", "character", "patch"],
  },
  "action.agent.turn": {
    label: "Agent turn",
    description:
      "Run one full agent turn — tool-enabled via the desktop sidecar (approval-gated), text-only fallback on web.",
    iconName: "Bot",
    keywords: ["agent", "claude", "tools", "turn", "assistant", "llm"],
  },
  "action.goal.create": {
    label: "Create goal",
    description: "Create a self-driving /goal for a chat session through the GoalRuntime.",
    iconName: "Target",
    keywords: ["goal", "objective", "create", "start", "self-driving"],
  },
  "action.goal.get": {
    label: "Get goal",
    description: "Read one goal by id and return a redaction-safe snapshot.",
    iconName: "Target",
    keywords: ["goal", "read", "get", "objective", "status"],
  },
  "action.goal.list": {
    label: "List goals",
    description: "List goals globally, by session, or the active/open goal for a session.",
    iconName: "Target",
    keywords: ["goal", "list", "history", "session", "active", "open"],
  },
  "action.goal.events": {
    label: "List goal events",
    description: "Read a goal's lifecycle event timeline.",
    iconName: "Target",
    keywords: ["goal", "events", "activity", "timeline", "audit"],
  },
  "action.goal.updateObjective": {
    label: "Update goal objective",
    description: "Replace a non-terminal goal objective via the GoalRuntime redaction path.",
    iconName: "Target",
    keywords: ["goal", "objective", "update", "redact"],
  },
  "action.goal.pause": {
    label: "Pause goal",
    description: "Pause an active goal and abort its in-flight turn driver.",
    iconName: "Target",
    keywords: ["goal", "pause", "hold", "lifecycle"],
  },
  "action.goal.resume": {
    label: "Resume goal",
    description: "Resume a paused goal so its turn loop can continue.",
    iconName: "Target",
    keywords: ["goal", "resume", "continue", "lifecycle"],
  },
  "action.goal.stop": {
    label: "Stop goal",
    description: "Stop a non-terminal goal and fire terminal goal side effects.",
    iconName: "Target",
    keywords: ["goal", "stop", "cancel", "terminal", "lifecycle"],
  },
  "action.goal.preempt": {
    label: "Preempt goal",
    description: "Mark an active goal as superseded by external work.",
    iconName: "Target",
    keywords: ["goal", "preempt", "supersede", "terminal", "lifecycle"],
  },
  "action.goal.updateConfig": {
    label: "Update goal config",
    description: "Patch pacing, budget, judge, and timeout settings on a non-terminal goal.",
    iconName: "Target",
    keywords: ["goal", "config", "budget", "judge", "pacing", "settings"],
  },
  "action.goal.decomposeSubgoals": {
    label: "Decompose subgoals",
    description: "Use the configured judge model to decompose a goal into a checklist.",
    iconName: "Target",
    keywords: ["goal", "subgoal", "decompose", "checklist", "steps"],
  },
  "action.goal.toggleSubgoal": {
    label: "Toggle subgoal",
    description: "Flip one subgoal checklist item's done state.",
    iconName: "Target",
    keywords: ["goal", "subgoal", "toggle", "checklist", "done"],
  },
  "action.goal.clearSubgoals": {
    label: "Clear subgoals",
    description: "Remove the persisted subgoal checklist from a goal.",
    iconName: "Target",
    keywords: ["goal", "subgoal", "clear", "checklist", "delete"],
  },
  "action.goal.delete": {
    label: "Delete goal",
    description: "Delete a goal and its event log through GoalRuntime cleanup.",
    iconName: "Target",
    keywords: ["goal", "delete", "remove", "cleanup"],
  },
  "action.goal.analytics": {
    label: "Goal analytics",
    description: "Compute goal completion, status, token, and timeline analytics.",
    iconName: "Target",
    keywords: ["goal", "analytics", "metrics", "completion", "timeline"],
  },
  "action.goal.template.list": {
    label: "List goal templates",
    description: "List seeded and user-authored goal templates with favorite/search filters.",
    iconName: "LayoutTemplate",
    keywords: ["goal", "template", "preset", "list", "favorite", "objective"],
  },
  "action.goal.template.createGoal": {
    label: "Create goal from template",
    description: "Resolve a goal template and create a GoalRuntime-backed goal for a session.",
    iconName: "LayoutTemplate",
    keywords: ["goal", "template", "preset", "create", "start", "objective"],
  },
  "action.goal.template.upsert": {
    label: "Upsert goal template",
    description: "Create or update a user goal template while preserving built-in clone semantics.",
    iconName: "LayoutTemplate",
    keywords: ["goal", "template", "preset", "upsert", "save", "objective"],
  },
  "action.goal.template.favorite": {
    label: "Favorite goal template",
    description: "Set a goal template's favorite flag so it sorts near the top of pickers.",
    iconName: "Star",
    keywords: ["goal", "template", "favorite", "pin", "preset"],
  },
  "action.goal.template.delete": {
    label: "Delete goal template",
    description: "Delete a user-authored goal template; built-in templates remain protected.",
    iconName: "Trash2",
    keywords: ["goal", "template", "delete", "remove", "preset"],
  },
  "action.team.run": {
    label: "Run team",
    description: "Starts an agent team's lifecycle and waits for completion.",
    iconName: "Users",
    keywords: ["team", "agents", "multi", "supervisor"],
  },
  "action.team.task.dispatch": {
    label: "Dispatch team task",
    description:
      "Internal node emitted by the agent-team synthesizer per ADR-0022. One node per AgentTeamTask; selects a teammate from the per-run TeammatePool. Not hand-authored.",
    iconName: "Send",
    keywords: ["team", "task", "dispatch", "synthesized", "internal"],
  },
  "action.team.reconcile": {
    label: "Reconcile agent worktrees",
    description:
      "Under workspace isolation, reconcile the per-dispatch agent branches produced so far in this run — merge-all / select / pipeline. Runs inside a team run (reads the per-run worktree ledger).",
    iconName: "GitMerge",
    keywords: ["team", "worktree", "git", "reconcile", "merge", "select"],
  },
  "action.team.create": {
    label: "Create team",
    description: "Creates a new agent team row.",
    iconName: "Users",
    keywords: ["team", "create"],
  },
  "action.team.update": {
    label: "Update team",
    description: "Patches an existing team's roster or orchestration mode.",
    iconName: "Users",
    keywords: ["team", "update", "roster"],
  },
  "action.team.compose": {
    label: "Compose team from objective",
    description:
      "Auto-orchestrates an agent team from a single objective: routing assessment, roster composition, and task decomposition (PII-gated). Optionally starts the team immediately.",
    iconName: "Wand2",
    keywords: ["team", "auto", "compose", "orchestrate", "roster", "objective", "multi", "agents"],
  },
  "action.team.status": {
    label: "Get team status",
    description:
      "Reads an agent team's live state mid-workflow: status, final result, and optionally its tasks, teammates, and delegations.",
    iconName: "Users",
    keywords: ["team", "status", "result", "tasks", "query", "agents"],
  },
  "action.team.delegate": {
    label: "Delegate from team",
    description:
      "Delegates a sub-problem on behalf of a team to a digital twin, a background agent, an external agent (Claude Code / Codex), or another team — optionally awaiting the result.",
    iconName: "Share2",
    keywords: ["team", "delegate", "twin", "background", "external", "handoff", "agents"],
  },
  "action.team.message": {
    label: "Post team message",
    description:
      "Posts a message into an agent team's shared chat/blackboard, optionally addressed to a specific teammate or attached to a task.",
    iconName: "MessageSquare",
    keywords: ["team", "message", "blackboard", "chat", "broadcast", "agents"],
  },
  "action.plan.create": {
    label: "Create plan",
    description: "Create an AgentPlan for a session through the PlanRuntime lifecycle.",
    iconName: "ListChecks",
    keywords: ["plan", "agent", "create", "steps", "draft", "approval"],
  },
  "action.plan.get": {
    label: "Get plan",
    description: "Read one persisted AgentPlan by id.",
    iconName: "ListChecks",
    keywords: ["plan", "agent", "get", "read", "status"],
  },
  "action.plan.list": {
    label: "List plans",
    description: "List plans by workspace or session, with optional status filtering.",
    iconName: "ListChecks",
    keywords: ["plan", "agent", "list", "session", "open", "executing", "status"],
  },
  "action.plan.events": {
    label: "List plan events",
    description: "Read the newest lifecycle and step events for a plan.",
    iconName: "History",
    keywords: ["plan", "events", "history", "audit", "step", "log"],
  },
  "action.plan.updateDraft": {
    label: "Update plan draft",
    description: "Patch a non-executing plan's title, steps, config, or metadata.",
    iconName: "ClipboardPen",
    keywords: ["plan", "draft", "update", "steps", "config", "metadata"],
  },
  "action.plan.approve": {
    label: "Approve plan",
    description: "Move a draft or pending plan into the approved state.",
    iconName: "BadgeCheck",
    keywords: ["plan", "approve", "approval", "lifecycle", "ready"],
  },
  "action.plan.reject": {
    label: "Reject plan",
    description: "Cancel a pending plan and record rejection feedback.",
    iconName: "CircleX",
    keywords: ["plan", "reject", "cancel", "feedback", "approval"],
  },
  "action.plan.refine": {
    label: "Refine plan",
    description: "Use the planner model to repair, expand, simplify, reorder, or optimize a plan.",
    iconName: "WandSparkles",
    keywords: ["plan", "refine", "repair", "replan", "optimize", "expand", "planner", "llm"],
  },
  "action.plan.pause": {
    label: "Pause plan",
    description: "Pause an executing plan and abort the active run controller.",
    iconName: "Pause",
    keywords: ["plan", "pause", "lifecycle", "abort", "executing"],
  },
  "action.plan.resume": {
    label: "Resume plan",
    description: "Resume a paused plan into the executing state.",
    iconName: "Play",
    keywords: ["plan", "resume", "lifecycle", "executing"],
  },
  "action.plan.cancel": {
    label: "Cancel plan",
    description: "Cancel a non-terminal plan and emit the runtime exit event.",
    iconName: "Ban",
    keywords: ["plan", "cancel", "stop", "terminal", "exit"],
  },
  "action.plan.delete": {
    label: "Delete plan",
    description: "Delete a plan and its event log through PlanRuntime cleanup.",
    iconName: "Trash2",
    keywords: ["plan", "delete", "remove", "cleanup", "events"],
  },
  "action.plan.run": {
    label: "Run plan",
    description: "Execute an approved plan through the orchestrated PlanRuntime path.",
    iconName: "Rocket",
    keywords: ["plan", "run", "execute", "orchestrator", "steps"],
  },
  "action.plan.setStepStatus": {
    label: "Set plan step status",
    description: "Update one plan step's status and recompute plan progress counts.",
    iconName: "ListTodo",
    keywords: ["plan", "step", "status", "progress", "completed", "failed"],
  },
  "action.scheduler.task.create": {
    label: "Create scheduled task",
    description: "Create a native scheduler task through the TaskScheduler lifecycle.",
    iconName: "CalendarPlus",
    keywords: ["scheduler", "task", "schedule", "create", "cron", "interval"],
  },
  "action.scheduler.task.get": {
    label: "Get scheduled task",
    description: "Read one native scheduled task by id.",
    iconName: "CalendarSearch",
    keywords: ["scheduler", "task", "get", "read", "status"],
  },
  "action.scheduler.task.list": {
    label: "List scheduled tasks",
    description: "List native scheduler tasks with optional status, type, tag, and search filters.",
    iconName: "CalendarDays",
    keywords: ["scheduler", "task", "list", "filter", "status", "tags"],
  },
  "action.scheduler.task.update": {
    label: "Update scheduled task",
    description:
      "Patch a scheduled task's metadata, trigger, payload, config, or lifecycle status.",
    iconName: "CalendarCog",
    keywords: ["scheduler", "task", "update", "patch", "trigger", "payload", "config"],
  },
  "action.scheduler.task.pause": {
    label: "Pause scheduled task",
    description: "Pause a native scheduler task and disarm its next run.",
    iconName: "Pause",
    keywords: ["scheduler", "task", "pause", "pause task", "disable", "stop"],
  },
  "action.scheduler.task.resume": {
    label: "Resume scheduled task",
    description: "Resume a paused scheduler task and recalculate its next run.",
    iconName: "Play",
    keywords: ["scheduler", "task", "resume", "enable", "active"],
  },
  "action.scheduler.task.delete": {
    label: "Delete scheduled task",
    description: "Delete a scheduler task and its execution records.",
    iconName: "Trash2",
    keywords: ["scheduler", "task", "delete", "remove", "cleanup"],
  },
  "action.scheduler.task.runNow": {
    label: "Run scheduled task now",
    description: "Execute a scheduler task immediately through its registered task executor.",
    iconName: "Rocket",
    keywords: ["scheduler", "task", "run", "execute", "manual", "now"],
  },
  "action.scheduler.task.executions": {
    label: "List task executions",
    description: "Read recent execution history for a scheduler task.",
    iconName: "History",
    keywords: ["scheduler", "task", "executions", "runs", "history", "log"],
  },
  "action.scheduler.task.backfill": {
    label: "Backfill scheduled task",
    description: "Replay one scheduled task across an explicit time window.",
    iconName: "CalendarClock",
    keywords: ["scheduler", "task", "backfill", "replay", "window", "catch up"],
  },
  "action.scheduler.task.export": {
    label: "Export scheduled tasks",
    description: "Export selected scheduler task definitions for migration or backup.",
    iconName: "FileDown",
    keywords: ["scheduler", "task", "export", "backup", "migrate", "tasks"],
  },
  "action.scheduler.task.import": {
    label: "Import scheduled tasks",
    description: "Import scheduler task definitions from an exported JSON bundle.",
    iconName: "FileUp",
    keywords: ["scheduler", "task", "import", "import tasks", "restore", "migrate", "tasks"],
  },
  "action.scheduler.status": {
    label: "Get scheduler status",
    description: "Read native scheduler daemon health and lifecycle status.",
    iconName: "Activity",
    keywords: ["scheduler", "status", "health", "daemon", "service"],
  },
  "action.scheduler.statistics": {
    label: "Get scheduler statistics",
    description: "Read aggregate scheduler task and execution counters.",
    iconName: "ChartColumn",
    keywords: ["scheduler", "statistics", "stats", "metrics", "task", "execution"],
  },
  "action.scheduler.upcoming": {
    label: "List upcoming scheduled tasks",
    description: "Read the next armed scheduler task fires across the task registry.",
    iconName: "CalendarRange",
    keywords: ["scheduler", "upcoming", "next", "scheduled", "tasks", "fires"],
  },
  "action.scheduler.executions.recent": {
    label: "List recent scheduler executions",
    description: "Read recent scheduler execution rows across all scheduled tasks.",
    iconName: "Rows3",
    keywords: ["scheduler", "executions", "recent", "recent executions", "runs", "history", "log"],
  },
  "action.scheduler.execution.get": {
    label: "Get scheduler execution",
    description: "Read one scheduler execution record by id.",
    iconName: "SearchCheck",
    keywords: ["scheduler", "execution", "get", "read", "history", "log"],
  },
  "action.scheduler.event.trigger": {
    label: "Trigger scheduler event",
    description: "Fan out an event into event-triggered scheduler tasks.",
    iconName: "RadioTower",
    keywords: ["scheduler", "event", "trigger", "fan out", "dispatch"],
  },
  "action.skill.invoke": {
    label: "Invoke skill",
    description: "Renders a skill into the prompt of the next AI step.",
    iconName: "Sparkles",
    keywords: ["skill", "instruction", "prompt"],
  },
  "action.skill.upsert": {
    label: "Upsert skill",
    description: "Creates or updates a skill with the given markdown body.",
    iconName: "Sparkles",
    keywords: ["skill", "edit", "save"],
  },
  "action.twin.rag": {
    label: "Twin RAG",
    description: "Runs RAG over a twin's vector store and returns the top-K chunks.",
    iconName: "Brain",
    keywords: ["twin", "rag", "search", "retrieve", "knowledge", "vector"],
  },
  "action.twin.ingest": {
    label: "Twin ingest",
    description: "Queues a new source for the twin's ingest pipeline.",
    iconName: "Brain",
    keywords: ["twin", "ingest", "import", "embed"],
  },
  "knowledge.source": {
    label: "Knowledge source",
    description: "Create or incrementally update a stable Knowledge Base source.",
    iconName: "Database",
    keywords: ["knowledge", "source", "sync", "web", "text"],
    paramsSchema: {
      type: "object",
      required: ["knowledgeBaseId", "sourceMode"],
      properties: {
        knowledgeBaseId: { type: "string", title: "Knowledge Base ID" },
        sourceMode: { type: "string", title: "Source mode", enum: ["text", "web", "existing"] },
        sourceId: { type: "string", title: "Existing source ID" },
        sourceKey: { type: "string", title: "Stable source key" },
        title: { type: "string", title: "Title" },
        format: { type: "string", title: "Format", default: "markdown" },
        content: { type: "string", title: "Content", format: "textarea" },
        url: { type: "string", title: "Web URL", format: "uri" },
      },
    },
  },
  "knowledge.parse": {
    label: "Parse knowledge",
    description: "Parse one persisted source into a protected run-scoped artifact.",
    iconName: "FileSearch",
    keywords: ["knowledge", "parse", "document", "extract"],
    paramsSchema: {
      type: "object",
      required: ["sourceId"],
      properties: { sourceId: { type: "string", title: "Source ID" } },
    },
  },
  "knowledge.transform": {
    label: "Transform knowledge",
    description: "Normalize and PII-redact parsed content before chunking.",
    iconName: "WandSparkles",
    keywords: ["knowledge", "transform", "redact", "pii"],
    paramsSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string", title: "Parsed artifact ID" } },
    },
  },
  "knowledge.chunk": {
    label: "Chunk knowledge",
    description: "Create format-aware chunks with stable position metadata.",
    iconName: "ListTree",
    keywords: ["knowledge", "chunk", "split", "position"],
    paramsSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string", title: "Transformed artifact ID" } },
    },
  },
  "knowledge.embed": {
    label: "Embed knowledge",
    description: "Embed chunks through Cognia's mandatory safe embedding gateway.",
    iconName: "BrainCircuit",
    keywords: ["knowledge", "embedding", "pii", "vector"],
    paramsSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string", title: "Chunk artifact ID" } },
    },
  },
  "knowledge.index": {
    label: "Validate knowledge index",
    description: "Validate vector counts and dimensions before publication.",
    iconName: "BadgeCheck",
    keywords: ["knowledge", "index", "validate", "revision"],
    paramsSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string", title: "Embedded artifact ID" } },
    },
  },
  "knowledge.publish": {
    label: "Publish knowledge revision",
    description: "Atomically publish a validated immutable index generation.",
    iconName: "UploadCloud",
    keywords: ["knowledge", "publish", "revision", "rollback", "atomic"],
    paramsSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string", title: "Validated index artifact ID" } },
    },
  },
  "knowledge.retrieve": {
    label: "Retrieve knowledge",
    description: "Retrieve ACL-filtered chunks from frozen Knowledge Base revisions.",
    iconName: "SearchCheck",
    keywords: ["knowledge", "retrieve", "rag", "acl", "citation"],
    paramsSchema: {
      type: "object",
      required: ["knowledgeBaseIds", "query"],
      properties: {
        knowledgeBaseIds: {
          type: "array",
          title: "Knowledge Base IDs",
          items: { type: "string" },
          minItems: 1,
        },
        query: { type: "string", title: "Query" },
        topKPerBase: { type: "number", title: "Top K per Knowledge Base", default: 4 },
        scoreThreshold: { type: "number", title: "Minimum score", minimum: 0, maximum: 1 },
        tokenBudget: { type: "number", title: "Token budget", default: 4000 },
        revisionBindings: {
          type: "object",
          title: "Frozen revision bindings",
          additionalProperties: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
          },
        },
      },
    },
  },
  "action.memory.recall": {
    label: "Recall memory",
    description: "Hybrid-search the long-term memory store (BM25 + vectors when configured).",
    iconName: "Brain",
    keywords: ["memory", "recall", "remember", "search", "long-term"],
  },
  "action.memory.store": {
    label: "Store memory",
    description:
      "Store one durable fact into long-term memory via the shared consolidator (PII-gated).",
    iconName: "Save",
    keywords: ["memory", "store", "remember", "save", "long-term"],
  },
  "action.connector.send": {
    label: "Send via connector",
    description: "Pushes a message through the outbound queue of a connected adapter.",
    iconName: "Send",
    keywords: ["telegram", "slack", "discord", "lark", "outbound", "send"],
  },
  "action.connector.draft": {
    label: "Save as draft",
    description: "Stores the proposed reply for human review in the Inbox.",
    iconName: "PencilLine",
    keywords: ["draft", "review", "inbox"],
  },
  "action.connector.reaction": {
    label: "React to message",
    description: "Adds an emoji reaction to a platform message via a connected adapter.",
    iconName: "SmilePlus",
    keywords: ["reaction", "emoji", "react", "lark", "acknowledge"],
  },
  "action.connector.delete": {
    label: "Delete message",
    description: "Recalls / deletes an already-sent platform message via a connected adapter.",
    iconName: "Trash2",
    keywords: ["delete", "recall", "withdraw", "message", "outbound"],
  },
  "action.connector.forward": {
    label: "Forward message",
    description:
      "Forwards a message (or merge-forwards several) to another conversation via a connected adapter.",
    iconName: "Forward",
    keywords: ["forward", "merge", "relay", "share", "message", "lark"],
  },
  "action.connector.waitReply": {
    label: "Wait for reply",
    description:
      "Pauses the run until a matching inbound message arrives in the conversation (or the wait times out). Routes the reply text downstream.",
    iconName: "MessageCircleReply",
    keywords: ["wait", "reply", "inbound", "listen", "response", "feedback"],
  },
  "action.approval.request": {
    label: "Request approval",
    description:
      "Pause until a human approves or rejects — from the desktop notification center or a paired phone. Routes downstream via Approved / Rejected handles.",
    iconName: "UserCheck",
    keywords: ["approval", "approve", "reject", "human", "hitl", "gate", "review", "phone"],
  },
  "action.humanInput.request": {
    label: "Request human input",
    description:
      "Pause for a schema-driven form response from assigned members or groups, then route by the selected action.",
    iconName: "ClipboardPenLine",
    keywords: ["human", "input", "form", "hitl", "wait", "quorum", "portal", "phone"],
  },
  // ── Remote device steps (ADR 0061 P3) — hub proxies to a paired device ────
  "action.mobile.camera": {
    label: "Take photo on phone",
    description: "Opens the camera on a paired phone and returns the capture (base64) to the run.",
    iconName: "Camera",
    keywords: ["mobile", "phone", "camera", "photo", "capture", "picture"],
    requires: ["camera"],
  },
  "action.mobile.scanBarcode": {
    label: "Scan barcode on phone",
    description: "Opens the barcode/QR scanner on a paired phone and returns the raw value.",
    iconName: "ScanLine",
    keywords: ["mobile", "phone", "scan", "barcode", "qr", "code"],
    requires: ["barcode-scan"],
  },
  "action.mobile.location": {
    label: "Get phone location",
    description: "Reads the current GPS position from a paired phone.",
    iconName: "MapPin",
    keywords: ["mobile", "phone", "location", "gps", "position", "geolocation"],
    requires: ["geolocation"],
  },
  "action.mobile.share": {
    label: "Share from phone",
    description: "Opens the native share sheet on a paired phone with the given text or link.",
    iconName: "Share2",
    keywords: ["mobile", "phone", "share", "send", "sheet"],
    requires: ["share-sheet"],
  },
  "action.mobile.notify": {
    label: "Notify phone",
    description: "Shows a local notification on a paired phone.",
    iconName: "BellRing",
    keywords: ["mobile", "phone", "notify", "notification", "alert"],
    requires: ["push-display"],
  },
  "action.mcp.invokeTool": {
    label: "Invoke MCP tool",
    description: "Calls a tool on a configured MCP server.",
    iconName: "Network",
    keywords: ["mcp", "tool", "call"],
  },
  "action.plugin.invoke": {
    label: "Invoke plugin",
    description: "Calls a plugin tool or legacy task handler registered in the plugin runtime.",
    iconName: "Boxes",
    keywords: ["plugin", "extension", "run", "tool"],
  },
  // ── Local Git (Source Control) ────────────────────────────────────────────
  "action.git.stage": {
    label: "Git stage",
    description: "Stage paths in the repo (git add). Defaults to the active workspace root.",
    iconName: "FilePlus2",
    keywords: ["git", "stage", "add", "index", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.git.commit": {
    label: "Git commit",
    description: "Commit staged changes with a message (optionally signed off).",
    iconName: "GitCommitHorizontal",
    keywords: ["git", "commit", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  // ── Cognia Sites (ADR-0084) ──
  //
  // Four kinds, not seven. `upload` is folded into `deploy` because
  // `deployVersion` refuses an un-uploaded version anyway, and two nodes would
  // make the author responsible for an ordering the service already enforces —
  // a flow that stops between them leaves a Site half-published. `takedown` and
  // `purge` are console-only: removing a live site from the internet, or
  // deleting managed provider resources, are not things an unattended DAG
  // should reach. `reconcile`'s whole output is meant for a human.
  "action.site.build": {
    label: "Build Site",
    description: "Build a Cognia Site into a new immutable version.",
    iconName: "Hammer",
    keywords: ["site", "build", "deploy", "cloudflare", "publish"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.site.deploy": {
    label: "Publish Site",
    description: "Upload a Site version to Cloudflare and make it serve traffic.",
    iconName: "Rocket",
    keywords: ["site", "deploy", "publish", "cloudflare", "release"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.site.rollback": {
    label: "Roll back Site",
    description: "Serve the version that was live before the current one.",
    iconName: "Undo2",
    keywords: ["site", "rollback", "revert", "deploy", "cloudflare"],
    desktopOnly: true,
    requires: ["shell"],
  },
  // No `desktopOnly` and no `requires`: a Dexie read that must answer in every
  // shell, so a flow can at least report what happened.
  "action.site.status": {
    label: "Site status",
    description: "Read a Site's live URL, current version, and unresolved failures.",
    iconName: "Activity",
    keywords: ["site", "status", "url", "version", "health"],
  },
  // ── Artifacts + Canvas ──
  //
  // Six kinds, not nine. No `delete`: an unattended DAG that removes a user's
  // saved output is a consent problem, and the dock has the button. No
  // `canvas.update`: a Canvas document is an editor buffer whose authoritative
  // copy is `editorRef.current.getValue()`, so a background write either stages
  // a diff nobody is there to accept or overwrites what someone is typing. No
  // `canvas.open`: revealing a panel means nothing in a headless run.
  //
  // None are `desktopOnly`: the artifact store and its Dexie tables exist in
  // every shell.
  "action.artifact.create": {
    label: "Create artifact",
    description: "Save content as a new artifact — chart, document, code, SVG, HTML or diagram.",
    iconName: "FilePlus2",
    keywords: ["artifact", "create", "chart", "document", "canvas"],
  },
  "action.artifact.update": {
    label: "Update artifact",
    description:
      'Write new content to an artifact, keeping the old one as a version. Honours "Review before apply".',
    iconName: "FilePen",
    keywords: ["artifact", "update", "revise", "version"],
  },
  "action.artifact.get": {
    label: "Read artifact",
    description: "Read one artifact in full, or list the artifacts in a conversation.",
    iconName: "FileSearch",
    keywords: ["artifact", "read", "get", "list", "search"],
  },
  "action.artifact.export": {
    label: "Export artifact",
    description:
      "Render an artifact to bytes — source, PNG or PDF — for a later step to write or send. Rasterising a chart needs its preview on screen.",
    iconName: "FileDown",
    keywords: ["artifact", "export", "png", "pdf", "render", "download"],
  },
  "action.canvas.create": {
    label: "Create Canvas document",
    description: "Open a new editable Canvas document with the given content.",
    iconName: "SquarePen",
    keywords: ["canvas", "create", "document", "editor"],
  },
  "action.canvas.get": {
    label: "Read Canvas document",
    description: "Read one Canvas document in full, or list the documents in a conversation.",
    iconName: "BookOpen",
    keywords: ["canvas", "read", "get", "list", "document"],
  },
  "action.git.push": {
    label: "Git push",
    description: "Push commits to a remote (optionally set upstream).",
    iconName: "ArrowUpFromLine",
    keywords: ["git", "push", "remote", "upstream", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.git.branch": {
    label: "Git branch",
    description: "Create or switch to a branch.",
    iconName: "GitBranch",
    keywords: ["git", "branch", "checkout", "switch", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  // ── Stacked branches (ADR — stacks as first-class) ────────────────────────
  // Addressing mirrors `action.git.*`. Every kind takes either an explicit
  // `branches` list or a `tipBranch` whose whole chain is resolved from the
  // recorded parent pointers.
  "action.stack.list": {
    label: "List stacks",
    description: "Find every stacked branch chain recorded in the repository.",
    iconName: "Layers",
    keywords: ["stack", "stacked", "branch", "chain", "pull request", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.stack.parent": {
    label: "Set stack parent",
    description: "Record (or clear) the branch a branch is stacked on.",
    iconName: "GitFork",
    keywords: ["stack", "parent", "base", "branch", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.stack.validate": {
    label: "Validate stack",
    description: "Check every layer actually contains its parent, and report what would fix it.",
    iconName: "ShieldCheck",
    keywords: ["stack", "validate", "ancestry", "check", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.stack.restack": {
    label: "Restack",
    description: "Replay the layers onto their base, moving every branch above the change.",
    iconName: "GitPullRequestArrow",
    keywords: ["stack", "restack", "rebase", "replay", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.stack.push": {
    label: "Push stack",
    description: "Push every layer with a lease, so a stale local view cannot overwrite work.",
    iconName: "ArrowUpFromLine",
    keywords: ["stack", "push", "force", "lease", "source control"],
    desktopOnly: true,
    requires: ["shell"],
  },
  // ── Embedded code-server "Pro IDE" (ADR-0088) ─────────────────────────────
  // `root` is optional on every one: it defaults to the bound Pro IDE, exactly
  // as `action.git.*`'s `repoPath` defaults to the active workspace root.
  "action.editor.open": {
    label: "Open in editor",
    description:
      "Open a file in the Pro IDE and reveal a line. Defaults to the bound Pro IDE workspace.",
    iconName: "FileCode",
    keywords: ["editor", "ide", "open", "file", "reveal", "vscode", "code-server", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  "action.editor.reveal": {
    label: "Reveal in editor explorer",
    description: "Reveal a path in the Pro IDE file explorer without opening it.",
    iconName: "FolderTree",
    keywords: ["editor", "ide", "reveal", "explorer", "locate", "vscode", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  "action.editor.showDiff": {
    label: "Show diff for review",
    description:
      "Show proposed content beside a file in the Pro IDE's native diff view. The proposal is served from memory and never written to disk.",
    iconName: "GitCompareArrows",
    keywords: ["editor", "ide", "diff", "review", "compare", "propose", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  "action.editor.readActive": {
    label: "Read active editor",
    description:
      "Read what the user is looking at: focused file, selection, selected text, diagnostics, open editors. PII-screened before it enters the run.",
    iconName: "ScanEye",
    keywords: ["editor", "ide", "active", "selection", "context", "diagnostics", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  "action.editor.applyEdit": {
    label: "Reflect edit in editor",
    description:
      "Reflect an already-written file as an undo-able in-editor edit instead of a bare external reload. Disk stays the source of truth.",
    iconName: "FilePen",
    keywords: ["editor", "ide", "edit", "apply", "undo", "reflect", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  "action.editor.saveAll": {
    label: "Save editor buffers",
    description:
      "Flush dirty Pro IDE buffers to disk so later steps read what the user is actually looking at. Narrow it to one file with 'path'.",
    iconName: "Save",
    keywords: ["editor", "ide", "save", "flush", "dirty", "buffer", "pro ide"],
    desktopOnly: true,
    requires: ["pro-ide"],
  },
  // ── Desktop UI automation ─────────────────────────────────────────────────
  "action.desktop.listApps": {
    label: "List desktop apps",
    description: "List applications available to an app-scoped Computer Use session.",
    iconName: "AppWindow",
    keywords: ["desktop", "applications", "computer use"],
    requires: ["uia-automation"],
  },
  "action.desktop.getAppState": {
    label: "Get app state",
    description: "Capture a fresh AX revision and matching window screenshot.",
    iconName: "Camera",
    keywords: ["desktop", "state", "tree", "screenshot", "revision"],
    requires: ["uia-automation"],
  },
  "action.desktop.queryElements": {
    label: "Query app elements",
    description: "Query elements in one captured app revision.",
    iconName: "Crosshair",
    keywords: ["desktop", "query", "element", "accessibility"],
    requires: ["uia-automation"],
  },
  "action.desktop.expandElement": {
    label: "Expand app element",
    description: "Page through children of an element in the canonical AX tree.",
    iconName: "ListTree",
    keywords: ["desktop", "expand", "children", "pagination"],
    requires: ["uia-automation"],
  },
  "action.desktop.performAction": {
    label: "Perform app action",
    description: "Perform one revision- and turn-bound semantic or pixel action.",
    iconName: "MousePointerClick",
    keywords: ["desktop", "action", "semantic", "pixel", "computer use"],
    requires: ["uia-automation"],
  },
  "trigger.desktop.event": {
    label: "On UIA event",
    description:
      "Fire on native Windows UI Automation focus, structure, or property changes, optionally scoped to one element. A per-workflow cooldown guards against the workflow's own desktop actions re-triggering it.",
    iconName: "Bell",
    keywords: ["desktop", "trigger", "event", "uia", "focus"],
    desktopOnly: true,
    requires: ["uia-automation"],
  },
  // ── System: integrated terminal ───────────────────────────────────────────
  "action.system.terminal": {
    label: "Run terminal command",
    description:
      "Run a shell command in the integrated terminal dock. Routes stdout / exit code downstream.",
    iconName: "Terminal",
    keywords: ["terminal", "shell", "command", "bash", "powershell", "dock", "run"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "action.terminal.session.open": {
    label: "Open terminal session",
    description:
      "Open a persistent terminal session (visible dock tab, or a headless private shell with unattended: true) for multi-step command runs.",
    iconName: "Terminal",
    keywords: ["terminal", "session", "shell", "open", "spawn", "headless", "unattended"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "action.terminal.session.run": {
    label: "Run in terminal session",
    description:
      "Run one command in a session opened by 'Open terminal session' and wait for its exit code.",
    iconName: "Terminal",
    keywords: ["terminal", "session", "shell", "command", "run", "exec"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "action.terminal.session.close": {
    label: "Close terminal session",
    description:
      "Close a terminal session opened earlier in this run. Leftover sessions are closed automatically when the run ends.",
    iconName: "Terminal",
    keywords: ["terminal", "session", "close", "kill", "cleanup"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "action.terminal.script": {
    label: "Run script file",
    description:
      "Run a script file (.sh / .ps1 / .py / .js / …) under the right interpreter, detected from its extension or overridden explicitly.",
    iconName: "Terminal",
    keywords: ["terminal", "script", "file", "interpreter", "python", "bash", "powershell", "node"],
    desktopOnly: true,
    requires: ["shell"],
  },
  "action.terminal.readRecent": {
    label: "Read terminal history",
    description:
      "Read the recent-commands ring (command, exit code, ended-at) of a terminal dock tab.",
    iconName: "Terminal",
    keywords: ["terminal", "read", "recent", "history", "commands", "ring"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "action.terminal.waitForExit": {
    label: "Wait for terminal exit",
    description:
      "Block until the command currently running in a terminal dock tab finishes, then route on its exit code.",
    iconName: "Terminal",
    keywords: ["terminal", "wait", "exit", "command", "finish", "long-running"],
    desktopOnly: true,
    requires: ["pty"],
  },
  "trigger.terminal.command": {
    label: "On terminal command",
    description:
      "Fires when a command finishes in a user-spawned terminal dock tab. Scope by session, project, exit status, or a command substring.",
    iconName: "Terminal",
    keywords: ["terminal", "trigger", "command", "exit", "failed", "shell", "dock"],
    desktopOnly: true,
    requires: ["pty"],
  },
  // ── AI primitives ─────────────────────────────────────────────────────────
  "ai.prompt": {
    label: "AI prompt",
    description: "Direct LLM call. Uses the configured provider routing.",
    iconName: "Bot",
    keywords: ["llm", "prompt", "chat", "claude", "openai", "ai"],
  },
  "ai.classify": {
    label: "Classify",
    description: "LLM-based classification into one of N labels.",
    iconName: "Bot",
    keywords: ["classify", "label", "category"],
  },
  "ai.council": {
    label: "Council",
    description: "Fan the prompt out to several models, then synthesize a consensus answer.",
    iconName: "Users",
    keywords: ["council", "consensus", "multi-model", "ensemble", "vote", "synthesize", "panel"],
  },
  "ai.ensemble": {
    label: "Ensemble",
    description: "Run a target N times, then vote / threshold / best-of / synthesize the samples.",
    iconName: "Vote",
    keywords: [
      "ensemble",
      "n-vote",
      "vote",
      "majority",
      "adversarial",
      "verify",
      "best-of",
      "sample",
      "self-consistency",
    ],
  },
  "ai.extract": {
    label: "Extract data",
    description: "Structured extraction (JSON schema) from free-form text.",
    iconName: "Bot",
    keywords: ["extract", "structured", "json", "schema"],
  },
  "ai.embed": {
    label: "Embed text",
    description: "Generate an embedding vector for semantic similarity.",
    iconName: "Bot",
    keywords: ["embed", "vector", "embedding"],
  },
  "ai.browserModel": {
    label: "Browser model",
    description: "Run an explicitly selected Transformers.js model locally in the browser.",
    iconName: "Cpu",
    keywords: ["browser", "local", "transformers", "wasm", "webgpu", "onnx"],
    defaultParams: {
      operation: "infer",
      task: "text-classification",
      dtype: "q8",
      cacheEnabled: true,
      maxCachedModels: 2,
    },
  },
  // ── Flow ──────────────────────────────────────────────────────────────────
  "flow.branch": {
    label: "If / else",
    description: "Routes execution down one of two branches based on a condition.",
    iconName: "GitBranch",
    keywords: ["if", "else", "branch", "condition"],
  },
  "flow.switch": {
    label: "Switch",
    description: "Multi-way branch on the value of an expression.",
    iconName: "GitBranch",
    keywords: ["switch", "case", "branch"],
  },
  "flow.split": {
    label: "Split (parallel)",
    description:
      "Fans out to multiple branches that run concurrently. Pure passthrough — every branch receives the SAME input; it does not partition or copy-slice data (use flow.loop or data.aggregate group-by for that).",
    iconName: "Workflow",
    keywords: ["parallel", "fan-out", "split"],
  },
  "flow.join": {
    label: "Join",
    description: "Joins parallel branches with all/any/race semantics.",
    iconName: "Workflow",
    keywords: ["join", "merge", "wait", "all", "any", "race"],
  },
  "flow.loop": {
    label: "Loop",
    description: "Repeats a sub-graph for-each / while / N times.",
    iconName: "Repeat",
    keywords: ["loop", "for-each", "while", "iterate"],
  },
  "flow.break": {
    label: "Break",
    description: "Stops the innermost loop after the current iteration.",
    iconName: "CircleStop",
    keywords: ["break", "stop", "loop", "exit"],
  },
  "flow.continue": {
    label: "Continue",
    description: "Skips the rest of the current loop iteration.",
    iconName: "SkipForward",
    keywords: ["continue", "skip", "loop", "next"],
  },
  "flow.wait": {
    label: "Wait",
    description: "Pauses for a fixed duration or until a wake-up event arrives.",
    iconName: "Timer",
    keywords: ["wait", "delay", "sleep", "pause"],
  },
  "flow.set": {
    label: "Set variable",
    description: "Assigns a value to a workflow-scoped variable.",
    iconName: "Variable",
    keywords: ["set", "var", "variable", "assign"],
  },
  "flow.subworkflow": {
    label: "Run subworkflow",
    description: "Invokes another workflow as a step.",
    iconName: "Workflow",
    keywords: ["subworkflow", "invoke", "nested"],
  },
  "flow.catch": {
    label: "Catch failure",
    description:
      "Runs only when the workflow fails terminally; receives the error and drives a recovery / notify path.",
    iconName: "ShieldAlert",
    keywords: ["catch", "error", "failure", "fallback", "recover", "rescue", "捕获", "兜底"],
  },
  // ── Data ──────────────────────────────────────────────────────────────────
  "data.transform": {
    label: "Transform",
    description: "Map / filter / reduce / sort over an input array or object.",
    iconName: "ArrowRightLeft",
    keywords: ["map", "filter", "reduce", "sort", "transform"],
  },
  "data.aggregate": {
    label: "Aggregate",
    description: "Reduce a list: collect / concat / merge / group-by / dedupe / numeric / custom.",
    iconName: "Sigma",
    keywords: ["aggregate", "reduce", "group", "dedupe", "merge", "sum", "collect", "concat"],
  },
  "data.code": {
    label: "Code",
    description: "Custom JS expression with a 5s timeout.",
    iconName: "Code2",
    keywords: ["code", "js", "javascript", "function", "custom"],
  },
  "data.template": {
    label: "Template",
    description: "Render a mustache-style template string against the upstream data.",
    iconName: "FileText",
    keywords: ["template", "mustache", "render", "string"],
  },
  "ocr.extract": {
    label: "Extract text (OCR)",
    description: "Run OCR on an image or PDF (URL, base64, or screen) and output its text.",
    iconName: "ScanText",
    keywords: ["ocr", "extract", "text", "image", "pdf", "scan", "recognize"],
  },
  // ── Eval ──────────────────────────────────────────────────────────────────
  "eval.run": {
    label: "Run eval",
    description:
      "Run an eval dataset against a chat / team / workflow target and output pass rates.",
    iconName: "ClipboardCheck",
    keywords: ["eval", "evaluate", "dataset", "score", "benchmark", "quality", "test"],
  },
  "eval.gate": {
    label: "Eval gate",
    description: "Pass/fail verdict for an eval run against thresholds; branches on pass / fail.",
    iconName: "ShieldCheck",
    keywords: ["eval", "gate", "threshold", "quality", "ci", "verdict"],
  },
  // ── IO ────────────────────────────────────────────────────────────────────
  "io.http": {
    label: "HTTP request",
    description: "Call an external HTTP API with retries and timeout.",
    iconName: "Globe",
    keywords: ["http", "fetch", "rest", "api", "request"],
  },
  "io.webhook.respond": {
    label: "Webhook respond",
    description: "Respond to the inbound webhook trigger with a payload.",
    iconName: "Webhook",
    keywords: ["webhook", "respond", "reply"],
    desktopOnly: true,
    requires: ["always-on"],
  },
  "io.output": {
    label: "Output",
    description: "Declare the workflow's typed terminal output (the published interface).",
    iconName: "FileOutput",
    keywords: ["output", "result", "return", "interface", "publish", "end"],
  },
  "io.answer": {
    label: "Answer",
    description: "Return a Chatflow answer with structured content, citations, and files.",
    iconName: "MessageSquareReply",
    keywords: ["answer", "chatflow", "reply", "citation", "suggestion", "file"],
  },
  "io.webClone": {
    label: "Web clone",
    description:
      "Snapshot a live web page (HTML + all CSS/JS/image/font assets) into a self-contained file or bundle, with optional component extraction + framework codegen.",
    iconName: "Globe",
    keywords: [
      "web",
      "clone",
      "snapshot",
      "scrape",
      "mirror",
      "download",
      "page",
      "assets",
      "codegen",
    ],
    desktopOnly: true,
    requires: ["shell"],
  },
  // ── Annotation ────────────────────────────────────────────────────────────
  "annotation.note": {
    label: "Sticky note",
    description: "Free-text note placed on the canvas. Has no execution.",
    iconName: "StickyNote",
    keywords: ["note", "sticky", "comment"],
  },
  "annotation.group": {
    label: "Group frame",
    description: "Visual group around several nodes. Has no execution.",
    iconName: "Box",
    keywords: ["group", "frame", "container"],
  },
}

/** All catalog entries, in canonical order. */
// The palette catalog covers every kind that ships palette metadata. Kinds
// that are synthesizer-emitted only (e.g. the agent-team `pattern.*` nodes,
// documented in `types/workflow/visual.ts` as "not placed by users in the
// editor") have no `ENTRIES` record and are intentionally absent here.
export const NODE_CATALOG: readonly NodeCatalogEntry[] = WORKFLOW_NODE_KINDS.flatMap((kind) => {
  const meta = ENTRIES[kind]
  if (!meta) return []
  return [{ kind, category: workflowNodeCategory(kind), ...meta }]
})

// ── Plugin-contributed entries (hot-merged) ──────────────────────────────────

const pluginCatalog = new Map<string, NodeCatalogEntry>()
const catalogListeners = new Set<() => void>()
// Cached snapshot. Held by reference identity so `useSyncExternalStore` sees
// the same array between renders unless the catalog actually changed —
// returning a fresh array each time would loop renders indefinitely.
let pluginCatalogSnapshot: readonly NodeCatalogEntry[] = []

function invalidateCatalogSnapshot(): void {
  pluginCatalogSnapshot = [...pluginCatalog.values()]
}

function notifyCatalogChanged(): void {
  // Catalog notifications run synchronously — consumers (Sidebar's
  // `useSyncExternalStore`) need to read the freshly-mutated map on the
  // same tick the snapshot identity changes.
  invalidateCatalogSnapshot()
  for (const fn of catalogListeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Catalog listener threw:", err)
    }
  }
}

/**
 * Register a plugin-contributed catalog entry. The runtime is expected to
 * have already prefixed `entry.kind` with `<pluginId>.` so naming stays
 * collision-free across plugins.
 */
export function addPluginCatalogEntry(entry: NodeCatalogEntry): void {
  pluginCatalog.set(entry.kind, entry)
  notifyCatalogChanged()
}

export function removePluginCatalogEntry(kind: string): void {
  if (!pluginCatalog.has(kind)) return
  pluginCatalog.delete(kind)
  notifyCatalogChanged()
}

/**
 * `useSyncExternalStore`-friendly subscribe hook. Returns an unsubscribe
 * function. Listeners fire whenever a plugin entry is added or removed.
 */
export function subscribePluginCatalog(fn: () => void): () => void {
  catalogListeners.add(fn)
  return () => {
    catalogListeners.delete(fn)
  }
}

/** Snapshot read for `useSyncExternalStore`. Identity is stable until the
 * catalog mutates — required by React's external-store contract. */
export function getPluginCatalogSnapshot(): readonly NodeCatalogEntry[] {
  return pluginCatalogSnapshot
}

/** Test-only — clears plugin catalog without touching built-ins. */
export function __resetPluginCatalogForTesting(): void {
  pluginCatalog.clear()
  catalogListeners.clear()
  invalidateCatalogSnapshot()
}

/**
 * Effective run-time capability requirements of an entry (ADR 0060).
 * Explicit `requires` wins; a legacy `desktopOnly` flag without one maps to
 * `["shell"]` — `shell` is present exactly on the tauri baseline, so
 * `desktopOnly` ≡ tauri-only under the capability model. Every built-in
 * `desktopOnly` entry carries an explicit backfill; only future/plugin
 * entries hit the fallback.
 */
export function effectiveRequires(
  entry: Pick<NodeCatalogEntry, "requires" | "desktopOnly">
): readonly CapabilityId[] {
  return entry.requires ?? (entry.desktopOnly ? ["shell"] : [])
}

/** Capabilities `entry` needs that are absent from `local`. */
export function missingCapabilities(
  entry: Pick<NodeCatalogEntry, "requires" | "desktopOnly">,
  local: readonly CapabilityId[]
): CapabilityId[] {
  return effectiveRequires(entry).filter((cap) => !local.includes(cap))
}

/**
 * Lookup an entry by kind. Resolution order: built-in catalog → registered
 * plugin entry (so plugin nodes surface their real label/description/pluginId
 * to the inspector + canvas) → synthesized stub for unknown kinds.
 */
export function nodeCatalogEntry(kind: WorkflowNodeKind): NodeCatalogEntry {
  const meta = ENTRIES[kind]
  if (meta) return { kind, category: workflowNodeCategory(kind), ...meta }
  const pluginEntry = pluginCatalog.get(kind)
  if (pluginEntry) return pluginEntry
  return {
    kind,
    category: workflowNodeCategory(kind),
    label: kind,
    description: "",
    iconName: "Box",
    keywords: [],
  }
}

/**
 * Group the catalog by category. The outer order matches the user-facing
 * sidebar grouping; within a group entries follow the canonical order.
 *
 * Plugin-contributed entries always appear in a single virtual `"plugin"`
 * group at the bottom; per-pluginId sub-grouping is the sidebar component's
 * responsibility (so it can pick its own sub-group label / icon).
 */
export function groupedCatalog(opts?: {
  includeDesktopOnly?: boolean
  includeHidden?: boolean
}): Array<{ category: WorkflowNodeCategory | "plugin"; entries: NodeCatalogEntry[] }> {
  const desktopOnly = opts?.includeDesktopOnly ?? true
  const includeHidden = opts?.includeHidden ?? false
  const order: WorkflowNodeCategory[] = [
    "trigger",
    "action",
    "ai",
    "flow",
    "data",
    "io",
    "annotation",
  ]
  const builtinGroups = order.map((category) => ({
    category: category as WorkflowNodeCategory | "plugin",
    entries: NODE_CATALOG.filter(
      (e) =>
        e.category === category && (includeHidden || !e.hidden) && (desktopOnly || !e.desktopOnly)
    ),
  }))
  const pluginEntries = [...pluginCatalog.values()].filter(
    (e) => (includeHidden || !e.hidden) && (desktopOnly || !e.desktopOnly)
  )
  if (pluginEntries.length === 0) return builtinGroups
  return [...builtinGroups, { category: "plugin" as const, entries: pluginEntries }]
}

/**
 * Fuzzy-search the catalog by a query string. Matches on label, description,
 * kind, and keyword list. Sorted by a simple relevance score:
 *   1. Exact label match → 100
 *   2. Label startsWith   → 80
 *   3. Label contains     → 60
 *   4. Keyword contains   → 40
 *   5. Description contains → 20
 *   6. Kind contains      → 10
 * Entries with a score of 0 are dropped.
 *
 * NB: this is a deliberately substring-based scorer, NOT the composer's
 * shared subsequence matcher (`lib/chat/completion/fuzzy-match`). Its data is
 * short labels + curated keyword/kind fallback buckets; subsequence matching
 * regresses ranking here (a short query like "cron" spuriously matches a long
 * multi-word label like "Close Terminal Session" and outranks the real
 * keyword hit). The two scorers intentionally stay separate.
 */
export function searchCatalog(
  query: string,
  opts?: {
    includeDesktopOnly?: boolean
    /**
     * Localized display strings per entry (built-ins via
     * `workflows.nodes.<kind>`, plugin nodes via their
     * `plugin.<pluginId>.workflow.nodes.<rawKind>` overlay). When supplied,
     * the translated label/description participate in matching alongside the
     * English catalog text, so e.g. a zh-CN user can search "循环" and find
     * `flow.loop`, or a localized plugin node by its translated name. Receives
     * the full entry so callers can branch on `pluginId`.
     */
    getText?: (entry: NodeCatalogEntry) => { label?: string; description?: string } | undefined
  }
): NodeCatalogEntry[] {
  const q = query.trim().toLowerCase()
  const desktopOnly = opts?.includeDesktopOnly ?? true
  const all: NodeCatalogEntry[] = [...NODE_CATALOG, ...pluginCatalog.values()]
  if (!q) return all
  const scored = all
    .filter((e) => desktopOnly || !e.desktopOnly)
    .map((e) => {
      const localized = opts?.getText?.(e)
      const labels = [e.label, localized?.label].filter(
        (v): v is string => typeof v === "string" && v !== ""
      )
      const descs = [e.description, localized?.description].filter(
        (v): v is string => typeof v === "string" && v !== ""
      )
      const kind = e.kind.toLowerCase()
      let score = 0
      for (const raw of labels) {
        const label = raw.toLowerCase()
        if (label === q) score = Math.max(score, 100)
        else if (label.startsWith(q)) score = Math.max(score, 80)
        else if (label.includes(q)) score = Math.max(score, 60)
      }
      if (e.keywords.some((k) => k.toLowerCase().includes(q))) score = Math.max(score, 40)
      if (descs.some((d) => d.toLowerCase().includes(q))) score = Math.max(score, 20)
      if (kind.includes(q)) score = Math.max(score, 10)
      return { entry: e, score }
    })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry)
}
