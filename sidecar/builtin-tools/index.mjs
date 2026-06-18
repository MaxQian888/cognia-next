// Compose the cognia-tools SDK MCP server.
//
// Loads metadata from `lib/settings/builtin-tools-data.json` (shared with
// the React settings UI) so server name, version, and category-tool
// associations stay in sync.
//
// `buildCogniaToolsServer({ enabled })` returns either:
//   - `null` when no categories are enabled (caller should skip registration)
//   - an `McpSdkServerConfigWithInstance` ready to be merged into the
//     `mcpServers` field of the SDK's `query()` options.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"

import data from "../../lib/settings/builtin-tools-data.json" with { type: "json" }

import { fileExtrasTools } from "./file-ops/index.mjs"
import { gitTools } from "./git/index.mjs"
import { processTools } from "./process/index.mjs"
import { environmentTools } from "./environment.mjs"
import { shellAdvancedTools } from "./shell-advanced.mjs"
import { terminalReplTools } from "./terminal-repl-tool.mjs"
import { createLspTools } from "./lsp.mjs"
import { createCoreTools } from "./core/core-tools.mjs"
import { createExitPlanTool } from "./exit-plan.mjs"

/** @type {Record<string, ReadonlyArray<unknown>>} */
const TOOLS_BY_CATEGORY = {
  fileExtras: fileExtrasTools,
  git: gitTools,
  process: processTools,
  environment: environmentTools,
  shellAdvanced: shellAdvancedTools,
  /**
   * Wave 1 — node-pty-backed interactive REPL surface. Orthogonal to
   * the renderer-relayed `terminal_dock_*` tools (those live in the
   * pluginTools manifest, see `lib/plugin/bridge/sidecar-tools-bridge.ts`):
   * REPL gives the agent a *private* persistent shell in the sidecar
   * for use cases that need stateful I/O (python / claude-code / sql).
   *
   * Lazy node-pty require — when the native binding is missing the
   * tool returns a clean structured error rather than crashing.
   */
  terminalRepl: terminalReplTools,
}

/**
 * Bare tool names for each category — read from the shared metadata JSON so
 * the sidecar and the UI never disagree about category membership.
 * @type {Record<string, ReadonlyArray<string>>}
 */
export const TOOL_NAMES_BY_CATEGORY = Object.freeze(
  Object.fromEntries(data.categories.map((c) => [c.id, c.tools.map((t) => t.name)]))
)

/**
 * Bare names of the read-only built-in tools (`requiresApproval === false`).
 * Plan mode allows only these and denies every mutating/exec tool, so the
 * non-Anthropic AI-SDK path enforces plan mode instead of trusting the model.
 * @type {ReadonlySet<string>}
 */
export const READ_ONLY_TOOL_NAMES = Object.freeze(
  new Set(
    data.categories.flatMap((c) =>
      c.tools.filter((t) => t.requiresApproval === false).map((t) => t.name)
    )
  )
)

export const SERVER_NAME = data.serverName
export const SERVER_VERSION = data.serverVersion

/**
 * Build the in-process SDK MCP server.
 *
 * @param {object} options
 * @param {{ fileExtras?: boolean, git?: boolean, process?: boolean, environment?: boolean, shellAdvanced?: boolean }} options.enabled
 * @param {boolean} [options.alwaysLoad]
 *        When true, every tool from this server is kept resident in the
 *        prompt and never deferred behind tool search (claude-agent-sdk
 *        `createSdkMcpServer({ alwaysLoad })`, equivalent to the API's
 *        `defer_loading: false`). When false/omitted and the CLI's tool
 *        search is active, this server's tools defer until discovered.
 * @returns {ReturnType<typeof createSdkMcpServer> | null}
 */
/**
 * Collect the raw `SdkMcpToolDefinition`s for the enabled categories (+ the
 * resolver-bound LSP tools). These are the same defs `buildCogniaToolsServer`
 * wraps into an in-process MCP server for the Anthropic path; exported so the
 * non-Anthropic AI-SDK bridge (`dispatch/ai-sdk-tools.mjs`) can convert them
 * into native AI SDK `tool()` objects (ADR-0043). Each def is
 * `{ name, description, inputSchema: <zod raw shape>, handler }`.
 *
 * @param {{
 *   enabled?: Record<string, boolean>,
 *   lspResolver?: unknown,
 *   readTracker?: unknown,
 *   cwd?: string,
 *   dispatchPath?: "anthropic" | "ai-sdk",
 * }} [options]
 * @returns {Array<{ name: string, description?: string, inputSchema?: unknown, handler: Function }>}
 */
export function collectCogniaToolDefs({
  enabled,
  lspResolver,
  readTracker,
  cwd,
  dispatchPath,
  bgShells,
  model,
  provider,
} = {}) {
  if (!enabled || typeof enabled !== "object") return []
  const tools = []
  for (const [category, toolList] of Object.entries(TOOLS_BY_CATEGORY)) {
    if (enabled[category]) {
      tools.push(...toolList)
    }
  }
  // The `lsp` category is resolver-bound (per-session), so it is not part of
  // the static TOOLS_BY_CATEGORY map — build its tools on demand when the
  // dispatch layer supplies a session LSP resolver.
  if (enabled.lsp && lspResolver) {
    tools.push(...createLspTools(lspResolver))
  }
  // The `coreFiles` suite (grep/glob/read/ls/edit/multi_edit/write/bash/
  // TodoWrite) is session-bound like lsp. It exists primarily for the ai-sdk
  // path, where the model has no SDK-native file tools; on the Anthropic path
  // it is OFF by default (the claude-agent-sdk ships its own Grep/Read/Edit/
  // Bash) unless the `coreFilesOnAnthropic` escape hatch is set — e.g. when a
  // user disables the SDK-native tools but still wants file access.
  const coreWanted =
    enabled.coreFiles &&
    readTracker &&
    (dispatchPath !== "anthropic" || enabled.coreFilesOnAnthropic === true)
  if (coreWanted) {
    tools.push(...createCoreTools({ cwd, readTracker, lspResolver, bgShells, model, provider }))
  }
  // The cross-provider plan-ready signal tool. The Anthropic path uses the
  // SDK-native `ExitPlanMode`, so register ours ONLY on the explicit ai-sdk
  // path (never for an unspecified/Anthropic path) to avoid duplicating it and
  // to preserve the "no categories → no tools" invariant. Always present on the
  // ai-sdk path (Claude Code parity — the system prompt governs *when* the
  // model calls it).
  if (dispatchPath === "ai-sdk") {
    tools.push(createExitPlanTool())
  }
  return tools
}

export function buildCogniaToolsServer({
  enabled,
  alwaysLoad,
  lspResolver,
  readTracker,
  cwd,
  dispatchPath,
  bgShells,
  model,
  provider,
}) {
  if (!enabled || typeof enabled !== "object") return null
  const tools = collectCogniaToolDefs({
    enabled,
    lspResolver,
    readTracker,
    cwd,
    dispatchPath,
    bgShells,
    model,
    provider,
  })
  if (tools.length === 0) return null
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}

/**
 * Return the namespaced tool names for any disabled categories. The sidecar
 * pushes these onto `disallowedTools` as defence-in-depth so a stray
 * reference to a disabled tool is rejected at the SDK boundary.
 *
 * @param {{ fileExtras?: boolean, git?: boolean, process?: boolean, environment?: boolean, shellAdvanced?: boolean }} enabled
 * @returns {string[]}
 */
export function namesForDisabledCategories(enabled) {
  if (!enabled || typeof enabled !== "object") {
    // No flags — return everything as disallowed.
    return Object.values(TOOL_NAMES_BY_CATEGORY).flat().map(namespacedName)
  }
  const out = []
  for (const [category, names] of Object.entries(TOOL_NAMES_BY_CATEGORY)) {
    if (!enabled[category]) {
      for (const n of names) out.push(namespacedName(n))
    }
  }
  return out
}

function namespacedName(toolName) {
  return `mcp__${SERVER_NAME}__${toolName}`
}

export { namespacedName }
