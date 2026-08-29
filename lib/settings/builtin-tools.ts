// Built-in tools metadata — single source of truth shared between the React
// settings UI and the Node sidecar (`sidecar/builtin-tools/`).
//
// Loads `builtin-tools-data.json` (which the sidecar also imports as a JSON
// module). The TypeScript layer adds typed wrappers + the `namespaced(name)`
// helper that returns the SDK-prefixed tool id (`mcp__<server>__<tool>`)
// used by `Character.allowedTools` / `Character.disallowedTools` /
// `AppSettings.alwaysAllowTools`.

import data from "./builtin-tools-data.json"

export type BuiltinToolCategoryId =
  | "fileExtras"
  | "coreFiles"
  | "git"
  | "process"
  | "environment"
  | "shellAdvanced"
  | "terminalRepl"
  | "lsp"
  | "codeGraph"
  | "astGrep"
  | "dependencyResearch"
  | "webclone"

export type BuiltinToolRiskLevel = "low" | "medium" | "high"

export interface BuiltinToolMeta {
  /** Bare tool name as registered with the MCP server (no prefix). */
  name: string
  /** i18n key under `toolSettings.<key>`. */
  descriptionKey: string
  riskLevel: BuiltinToolRiskLevel
  requiresApproval: boolean
  /** Mirror of the SDK's `tool({alwaysLoad})` flag. Read-only safe tools default to true. */
  alwaysLoad: boolean
  /**
   * Eligible to be exposed through the Code presentation's typed SDK
   * (ADR-0117, Phase 4).
   *
   * This is a **first-party allowlist**, deliberately declared per tool rather
   * than derived from `requiresApproval`. The two mean different things:
   * `requiresApproval: false` says "no per-call prompt", which is true of
   * `TodoWrite` and `TaskCreate` — tools that mutate state. Programmatic
   * read-only means the tool can be called in a loop from generated code with
   * no side effect at all. It is also deliberately not derived from the MCP
   * `readOnlyHint` annotation, which third-party servers declare about
   * themselves and which is therefore not a security boundary.
   */
  programmaticReadOnly?: boolean
}

export interface BuiltinToolCategory {
  id: BuiltinToolCategoryId
  /** i18n key under `toolSettings.<key>`. */
  nameKey: string
  /** i18n key under `toolSettings.<key>`. */
  descriptionKey: string
  /** Highest risk level among the category's tools — drives the card-level badge. */
  riskLevel: BuiltinToolRiskLevel
  /** Whether *any* tool in the category needs per-call approval — drives the warning icon. */
  requiresApproval: boolean
  /** Tools in this category run inside the Tauri sidecar, so they're desktop-only. */
  desktopOnly: boolean
  tools: BuiltinToolMeta[]
}

interface BuiltinToolsData {
  serverName: string
  serverVersion: string
  categories: BuiltinToolCategory[]
}

const TYPED_DATA = data as unknown as BuiltinToolsData

/** Name of the in-process MCP server the sidecar registers. */
export const BUILTIN_SERVER_NAME = TYPED_DATA.serverName

/** Version stamped on the in-process MCP server. */
export const BUILTIN_SERVER_VERSION = TYPED_DATA.serverVersion

/** All built-in tool categories, in display order. */
export const BUILTIN_TOOL_CATEGORIES: readonly BuiltinToolCategory[] = TYPED_DATA.categories

/**
 * `BuiltinToolsConfig` keys that are switches but NOT categories of their own —
 * modifiers on a category that already has a card. They have no entry in
 * `builtin-tools-data.json`, so anything that walks the categories alone will
 * silently omit them.
 */
export const BUILTIN_TOOL_MODIFIER_KEYS = ["coreFilesOnAnthropic"] as const

/**
 * Every switchable `BuiltinToolsConfig` key: the categories plus the modifiers.
 *
 * Four categories (`codeGraph`, `astGrep`, `dependencyResearch`, `webclone`)
 * used to exist only here — the CLI's config schema is `.strict()` and did not
 * list them, its `/settings` panel had no rows for them, and the CLI↔App bridge
 * dropped them on the way across. They worked at runtime (the CLI's tool host
 * gates on `enabled[category]` generically), so the only thing missing was a
 * way to switch them on. Deriving the CLI surfaces from this list is what stops
 * a new category reaching one surface and not the other.
 */
export const BUILTIN_TOOL_CONFIG_KEYS: readonly string[] = [
  ...BUILTIN_TOOL_CATEGORIES.map((category) => category.id),
  ...BUILTIN_TOOL_MODIFIER_KEYS,
]

/** Look up a category by id. Returns undefined if the id isn't recognised. */
export function getBuiltinToolCategory(id: string): BuiltinToolCategory | undefined {
  return BUILTIN_TOOL_CATEGORIES.find((c) => c.id === id)
}

/**
 * Map a bare tool name (e.g. `file_hash`) to its SDK-namespaced form
 * (`mcp__cognia-tools__file_hash`). The Claude Agent SDK exposes MCP-server
 * tools to agents under this prefix; per-character allowedTools /
 * disallowedTools / alwaysAllowTools all use the namespaced form.
 */
export function namespaced(toolName: string): string {
  return `mcp__${BUILTIN_SERVER_NAME}__${toolName}`
}

/** Iterator over every tool across every category. */
export function listBuiltinTools(): BuiltinToolMeta[] {
  return BUILTIN_TOOL_CATEGORIES.flatMap((c) => c.tools)
}

/**
 * The SDK-namespaced names of every built-in tool that does NOT require approval
 * — the read-only research surface. Derived from the same metadata that drives
 * the approval gate (never hand-listed) so a tool that becomes side-effecting is
 * dropped automatically. Used to scope the read-only Explore / Plan subagents.
 */
export function readOnlyBuiltinToolNames(): string[] {
  return listBuiltinTools()
    .filter((t) => !t.requiresApproval)
    .map((t) => namespaced(t.name))
}

/** All bare tool names belonging to a single category. */
export function listToolNamesInCategory(id: BuiltinToolCategoryId): string[] {
  const cat = getBuiltinToolCategory(id)
  return cat ? cat.tools.map((t) => t.name) : []
}

/** All namespaced tool names belonging to a single category. */
export function listNamespacedToolsInCategory(id: BuiltinToolCategoryId): string[] {
  return listToolNamesInCategory(id).map(namespaced)
}
