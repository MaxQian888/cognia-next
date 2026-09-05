/**
 * Pure presenters for the informational slash commands (`/tools`, `/cwd`,
 * `/about`). Kept out of the Ink component so the App router can produce notice
 * text deterministically and the logic is unit-tested without rendering.
 */
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"

import { backendIdentity } from "../runtime/backend-identity"
import type { ResolvedConfig } from "../../config/schema"

/** Human-readable label for each built-in tool category. */
const TOOL_LABELS: Record<string, string> = {
  coreFiles: "core file tools",
  coreFilesOnAnthropic: "core file tools on Anthropic",
  fileExtras: "file extras",
  git: "git",
  process: "process",
  environment: "environment",
  shellAdvanced: "advanced shell",
  terminalRepl: "terminal REPL",
  lsp: "LSP",
  codeGraph: "code graph",
  astGrep: "AST search & rewrite",
  dependencyResearch: "dependency source",
  webclone: "web page snapshot",
}

/**
 * Summarize which built-in tool categories are enabled. Returns a single line
 * suitable for a notice cell — "Enabled tools: …" or a hint when none are on.
 */
export function describeBuiltinTools(builtin: BuiltinToolsConfig): string {
  const enabled = Object.entries(builtin)
    .filter(([, on]) => on === true)
    .map(([key]) => TOOL_LABELS[key] ?? key)
  if (enabled.length === 0) return "No built-in tools are enabled."
  return `Enabled tools: ${enabled.join(", ")}`
}

/** One category in the built-in tool catalog (for the `/tools` document). */
export interface BuiltinToolCategory {
  key: keyof BuiltinToolsConfig
  label: string
  description: string
  /** The concrete tools the category registers (grounded in the sidecar). */
  tools: string[]
}

/**
 * The built-in tool catalog — what each `BuiltinToolsConfig` category provides.
 * Descriptions + tool names track `sidecar/builtin-tools/` and the
 * {@link BuiltinToolsConfig} doc comments; used only to render the `/tools`
 * reference document, so it is documentation, not a runtime source of truth.
 */
export const BUILTIN_TOOL_CATALOG: BuiltinToolCategory[] = [
  {
    key: "coreFiles",
    label: "core file tools",
    description:
      "Unified file-tool suite for the non-Anthropic path (mutating tools are approval-gated).",
    tools: ["read", "write", "edit", "multi_edit", "ls", "glob", "grep", "bash", "todowrite"],
  },
  {
    key: "coreFilesOnAnthropic",
    label: "core file tools on Anthropic",
    description:
      "Escape hatch that also registers the core suite on the Anthropic path (normally off — the SDK ships native equivalents).",
    tools: ["read", "write", "edit", "multi_edit", "ls", "glob", "grep", "bash"],
  },
  {
    key: "fileExtras",
    label: "file extras",
    description: "Advanced file ops the SDK's Read/Write/Glob/Grep don't cover.",
    tools: ["hash", "diff", "content_search"],
  },
  {
    key: "git",
    label: "git",
    description: "Structured git_* tools backed by the local git CLI.",
    tools: ["git_status", "git_diff", "git_log", "git_show", "git_blame"],
  },
  {
    key: "process",
    label: "process",
    description: "Manage host processes (high-risk — off by default).",
    tools: [
      "list_processes",
      "get_process",
      "search_processes",
      "start_process",
      "terminate_process",
    ],
  },
  {
    key: "environment",
    label: "environment",
    description: "Read-only environment inspection with secret redaction.",
    tools: ["list_env", "get_env", "system_info"],
  },
  {
    key: "shellAdvanced",
    label: "advanced shell",
    description: "Allowlist-gated single-program shell (overlaps SDK Bash — off by default).",
    tools: ["shell_execute_advanced"],
  },
  {
    key: "terminalRepl",
    label: "terminal REPL",
    description: "Interactive PTY sessions in the sidecar via node-pty (off by default).",
    tools: ["terminal_start", "terminal_write", "terminal_read", "terminal_close"],
  },
  {
    key: "lsp",
    label: "LSP",
    description: "Code-intelligence tools plus the diagnostics-after-edit loop (desktop only).",
    tools: ["goto_definition", "find_references", "hover", "document_symbols", "diagnostics"],
  },
  {
    key: "codeGraph",
    label: "code graph",
    description:
      "Structural code intelligence over a tree-sitter symbol graph — where a symbol is defined, who calls it, blast radius. Read-only, desktop only.",
    tools: [
      "codegraph_status",
      "codegraph_search",
      "codegraph_node",
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
      "codegraph_context",
      "codegraph_explore",
      "codegraph_files",
    ],
  },
  {
    key: "astGrep",
    label: "AST search & rewrite",
    description: "Structural search and rewrite over the syntax tree. Rewrites are approval-gated.",
    tools: ["ast_grep_search", "ast_grep_replace"],
  },
  {
    key: "dependencyResearch",
    label: "dependency source",
    description:
      "Clone a dependency's source repository into an ignored workspace so the agent can read library internals. HTTPS only, no build scripts run.",
    tools: ["clone_dep_source", "list_cloned_deps"],
  },
  {
    key: "webclone",
    label: "web page snapshot",
    description:
      "Snapshot a live page with its CSS/JS/image/font assets into a self-contained file or bundle. Private/loopback targets blocked unless opted in.",
    tools: ["web_clone", "web_clone_convert"],
  },
]

/**
 * Build the `/tools` reference document: each built-in tool category with its
 * enabled state, description, and the tools it registers, followed by pointers
 * to the external (MCP / plugin) tool viewers. Pure markdown.
 */
export function buildToolsCatalogDocument(builtin: BuiltinToolsConfig): string {
  const lines: string[] = ["# Built-in tools", "", describeBuiltinTools(builtin), ""]
  for (const cat of BUILTIN_TOOL_CATALOG) {
    const on = builtin[cat.key] === true
    lines.push(`## ${cat.label}  ${on ? "✓ enabled" : "✗ disabled"}`)
    lines.push("", cat.description, "", `Tools: ${cat.tools.join(", ")}`, "")
  }
  lines.push(
    "---",
    "",
    "External tools: `/mcp tools <server>` for MCP servers · `/plugin tools <id>` for plugin tools."
  )
  return lines.join("\n")
}

/**
 * One-line summary of the active config for `/about`: provider, model, auth
 * mode, and permission mode.
 */
export function aboutLine(config: ResolvedConfig, version: string, presetId?: string): string {
  const identity = backendIdentity(config, presetId)
  return [
    `cognia-agent v${version}`,
    identity.provider,
    ...(identity.model ? [identity.model] : identity.external ? [] : ["default"]),
    ...(!identity.external ? [authMode(config)] : []),
    `${config.permissionMode} mode`,
  ].join(" · ")
}

/** Which credential the active provider will authenticate with. */
export function authMode(config: ResolvedConfig): string {
  return providerAuthMode(config, config.provider)
}

/** Which credential a specific provider id will authenticate with. */
export function providerAuthMode(config: ResolvedConfig, providerId: string): string {
  const p = config.providers[providerId]
  if (p?.authToken) return "subscription"
  if (p?.apiKey) return "api key"
  return "no credential"
}
