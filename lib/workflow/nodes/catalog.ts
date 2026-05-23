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
  "trigger.github.webhook": {
    label: "On GitHub event",
    description:
      "Fires when GitHub posts a webhook (PR opened, Issue labeled, push, …). Verifies x-hub-signature-256.",
    iconName: "GitBranch",
    keywords: ["github", "webhook", "pr", "issue", "push", "release"],
    desktopOnly: true,
  },
  "trigger.team": {
    label: "On team run start",
    description:
      "Internal trigger fired by the agent-team synthesizer when runTeamLifecycle starts a run. Not hand-authored.",
    iconName: "Users",
    keywords: ["team", "synthesized", "internal"],
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
  "action.team.task.dispatch": {
    label: "Dispatch team task",
    description:
      "Internal node emitted by the agent-team synthesizer per ADR-0022. One node per AgentTeamTask; selects a teammate from the per-run TeammatePool. Not hand-authored.",
    iconName: "Send",
    keywords: ["team", "task", "dispatch", "synthesized", "internal"],
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
  // ── GitHub Delivery ───────────────────────────────────────────────────────
  "action.github.openPr": {
    label: "Open GitHub PR",
    description: "Opens a pull request via the GitHub Delivery plugin (policy-gated).",
    iconName: "GitPullRequest",
    keywords: ["github", "pr", "pull request", "open"],
  },
  "action.github.closePr": {
    label: "Close GitHub PR",
    description: "Closes an open pull request without merging.",
    iconName: "GitPullRequestClosed",
    keywords: ["github", "pr", "close"],
  },
  "action.github.mergePr": {
    label: "Merge GitHub PR",
    description: "Merges a pull request. Requires CI green + human approval per policy.",
    iconName: "GitMerge",
    keywords: ["github", "pr", "merge", "squash", "rebase"],
  },
  "action.github.reviewPr": {
    label: "Review GitHub PR",
    description: "Submits a review (APPROVE / REQUEST_CHANGES / COMMENT) on a PR.",
    iconName: "Eye",
    keywords: ["github", "pr", "review", "approve"],
  },
  "action.github.reviewPrInline": {
    label: "Inline review with AI",
    description:
      "Uses an LLM to produce a structured review (overall body + line-anchored inline comments) for a PR.",
    iconName: "Eye",
    keywords: ["github", "pr", "review", "ai", "inline", "comments"],
  },
  "action.github.commentPr": {
    label: "Comment on PR",
    description: "Posts a comment on a pull request.",
    iconName: "MessageCircle",
    keywords: ["github", "pr", "comment"],
  },
  "action.github.commentIssue": {
    label: "Comment on Issue",
    description: "Posts a comment on an issue.",
    iconName: "MessageCircle",
    keywords: ["github", "issue", "comment"],
  },
  "action.github.labelIssue": {
    label: "Label Issue/PR",
    description: "Adds or removes labels on an issue or pull request.",
    iconName: "Tag",
    keywords: ["github", "label", "tag"],
  },
  "action.github.closeIssue": {
    label: "Close Issue",
    description: "Closes an issue with optional reason (completed / not_planned).",
    iconName: "CircleDot",
    keywords: ["github", "issue", "close"],
  },
  "action.github.createRelease": {
    label: "Create Release",
    description: "Creates a Release. Drafts always allowed; published releases gated.",
    iconName: "Tag",
    keywords: ["github", "release", "publish", "draft"],
  },
  "action.github.generateChangelog": {
    label: "Generate changelog",
    description: "Computes Conventional-Commit semver bump + Markdown release notes.",
    iconName: "FileText",
    keywords: ["github", "release", "changelog", "conventional"],
  },
  "action.github.pushTag": {
    label: "Push tag",
    description: "Pushes a git tag to the repo.",
    iconName: "Tag",
    keywords: ["github", "tag", "push"],
  },
  "action.github.runIssueLoop": {
    label: "Issue → PR loop",
    description: "End-to-end Issue → AI worktree → PR loop. Clones, drives the AI, opens a PR.",
    iconName: "Repeat",
    keywords: ["github", "issue", "pr", "ai", "loop", "claude"],
  },
  // ── Desktop UI automation ─────────────────────────────────────────────────
  "action.desktop.screenshot": {
    label: "Screenshot",
    description: "Capture the primary monitor or a region. Returns PNG bytes + dims.",
    iconName: "Camera",
    keywords: ["desktop", "screen", "screenshot", "capture", "image"],
  },
  "action.desktop.findElement": {
    label: "Find element",
    description: "Locate a UI element by name / automation id / control type.",
    iconName: "Crosshair",
    keywords: ["desktop", "find", "element", "uia", "accessibility"],
  },
  "action.desktop.readTree": {
    label: "Read tree",
    description: "Snapshot the accessibility subtree as JSON for downstream nodes.",
    iconName: "ListTree",
    keywords: ["desktop", "tree", "accessibility", "uia"],
  },
  "action.desktop.click": {
    label: "Click",
    description: "Click an element or absolute screen coordinate.",
    iconName: "MousePointerClick",
    keywords: ["desktop", "click", "mouse"],
  },
  "action.desktop.type": {
    label: "Type text",
    description: "Type a string into the focused element via SendInput.",
    iconName: "Keyboard",
    keywords: ["desktop", "type", "keyboard", "input"],
  },
  "action.desktop.keys": {
    label: "Send keys",
    description: "Send a keyboard chord like ctrl+shift+t.",
    iconName: "Keyboard",
    keywords: ["desktop", "keys", "chord", "hotkey", "keyboard"],
  },
  "action.desktop.invokePattern": {
    label: "Invoke pattern",
    description: "Dispatch a UIA pattern (Invoke / Toggle / Value / Transform / …).",
    iconName: "Zap",
    keywords: ["desktop", "uia", "pattern", "invoke", "toggle"],
  },
  "action.desktop.windowFocus": {
    label: "Focus window",
    description: "Bring a window to the foreground.",
    iconName: "AppWindow",
    keywords: ["desktop", "window", "focus", "foreground"],
  },
  "action.desktop.windowClose": {
    label: "Close window",
    description: "Close a window via the UIA Window pattern.",
    iconName: "X",
    keywords: ["desktop", "window", "close"],
  },
  "action.desktop.windowResize": {
    label: "Resize window",
    description: "Move/resize a window via the UIA Transform pattern.",
    iconName: "Move",
    keywords: ["desktop", "window", "resize", "move"],
  },
  "action.desktop.wait": {
    label: "Wait for element",
    description: "Block until an element appears, disappears, or matches a property.",
    iconName: "Hourglass",
    keywords: ["desktop", "wait", "element", "appear"],
  },
  "trigger.desktop.event": {
    label: "On UIA event",
    description: "Fire when a UIA focus / structure / property event matches.",
    iconName: "Bell",
    keywords: ["desktop", "trigger", "event", "uia", "focus"],
  },
  // ── System: integrated terminal ───────────────────────────────────────────
  "action.system.terminal": {
    label: "Run terminal command",
    description:
      "Run a shell command in the integrated terminal dock. Routes stdout / exit code downstream.",
    iconName: "Terminal",
    keywords: ["terminal", "shell", "command", "bash", "powershell", "dock", "run"],
    desktopOnly: true,
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
 */
export function searchCatalog(
  query: string,
  opts?: { includeDesktopOnly?: boolean }
): NodeCatalogEntry[] {
  const q = query.trim().toLowerCase()
  const desktopOnly = opts?.includeDesktopOnly ?? true
  const all: NodeCatalogEntry[] = [...NODE_CATALOG, ...pluginCatalog.values()]
  if (!q) return all
  const scored = all
    .filter((e) => desktopOnly || !e.desktopOnly)
    .map((e) => {
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
