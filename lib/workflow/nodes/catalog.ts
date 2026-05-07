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

export interface NodeCatalogEntry {
  kind: WorkflowNodeKind
  category: WorkflowNodeCategory
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
}

const ENTRIES: Record<WorkflowNodeKind, Omit<NodeCatalogEntry, "kind" | "category">> = {
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
  "trigger.chat.message": {
    label: "On chat message",
    description: "Fires when a user sends a message in a bound character session.",
    iconName: "MessageSquare",
    keywords: ["chat", "user", "message", "session"],
  },
  "trigger.webhook": {
    label: "On webhook",
    description: "Fires when an HTTP request hits the workflow's webhook path.",
    iconName: "Webhook",
    keywords: ["webhook", "http", "post", "endpoint"],
    desktopOnly: true,
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
  "action.team.run": {
    label: "Run team",
    description: "Starts an agent team's lifecycle and waits for completion.",
    iconName: "Users",
    keywords: ["team", "agents", "multi", "supervisor"],
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
  "action.mcp.invokeTool": {
    label: "Invoke MCP tool",
    description: "Calls a tool on a configured MCP server.",
    iconName: "Network",
    keywords: ["mcp", "tool", "call"],
  },
  "action.plugin.invoke": {
    label: "Invoke plugin",
    description: "Calls a plugin task handler registered in the plugin runtime.",
    iconName: "Boxes",
    keywords: ["plugin", "extension", "run"],
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
    description: "Fans out to multiple branches that run concurrently.",
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
  // ── Data ──────────────────────────────────────────────────────────────────
  "data.transform": {
    label: "Transform",
    description: "Map / filter / reduce / sort over an input array or object.",
    iconName: "ArrowRightLeft",
    keywords: ["map", "filter", "reduce", "sort", "transform"],
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
export const NODE_CATALOG: readonly NodeCatalogEntry[] = WORKFLOW_NODE_KINDS.map((kind) => ({
  kind,
  category: workflowNodeCategory(kind),
  ...ENTRIES[kind],
}))

/** Lookup an entry by kind. Falls back to a synthesized entry for unknown kinds. */
export function nodeCatalogEntry(kind: WorkflowNodeKind): NodeCatalogEntry {
  const meta = ENTRIES[kind]
  if (meta) return { kind, category: workflowNodeCategory(kind), ...meta }
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
 */
export function groupedCatalog(opts?: {
  includeDesktopOnly?: boolean
  includeHidden?: boolean
}): Array<{ category: WorkflowNodeCategory; entries: NodeCatalogEntry[] }> {
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
  return order.map((category) => ({
    category,
    entries: NODE_CATALOG.filter(
      (e) =>
        e.category === category && (includeHidden || !e.hidden) && (desktopOnly || !e.desktopOnly)
    ),
  }))
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
 */
export function searchCatalog(
  query: string,
  opts?: { includeDesktopOnly?: boolean }
): NodeCatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...NODE_CATALOG]
  const desktopOnly = opts?.includeDesktopOnly ?? true
  const scored = NODE_CATALOG.filter((e) => desktopOnly || !e.desktopOnly).map((e) => {
    const label = e.label.toLowerCase()
    const desc = e.description.toLowerCase()
    const kind = e.kind.toLowerCase()
    let score = 0
    if (label === q) score = Math.max(score, 100)
    else if (label.startsWith(q)) score = Math.max(score, 80)
    else if (label.includes(q)) score = Math.max(score, 60)
    if (e.keywords.some((k) => k.toLowerCase().includes(q))) score = Math.max(score, 40)
    if (desc.includes(q)) score = Math.max(score, 20)
    if (kind.includes(q)) score = Math.max(score, 10)
    return { entry: e, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry)
}
