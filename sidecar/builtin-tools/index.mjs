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
import { processTools, createProcessTools } from "./process/index.mjs"
import { environmentTools } from "./environment.mjs"
import { shellAdvancedTools } from "./shell-advanced.mjs"
import { terminalReplTools } from "./terminal-repl-tool.mjs"
import { astGrepTools } from "./ast-grep/index.mjs"
import { clonedepsTools } from "./clonedeps/index.mjs"
import { webcloneTools } from "./webclone/index.mjs"
import { createLspTools } from "./lsp.mjs"
import { createCodeGraphTools } from "./code/tools.mjs"
import { createCoreTools } from "./core/core-tools.mjs"
import { createMonitorTools } from "./core/monitor.mjs"
import { createExitPlanTool } from "./exit-plan.mjs"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  wrapDefsWithReadOnlyTimeout,
} from "./read-only-timeout.mjs"
import { wrapDefsWithResultCap } from "./result-cap.mjs"

/** @type {Record<string, ReadonlyArray<unknown>>} */
const TOOLS_BY_CATEGORY = {
  fileExtras: fileExtrasTools,
  git: gitTools,
  /**
   * Supervisor-bound at collect time: `start_process` / `terminate_process`
   * route through the session's background-job supervisor when one exists, so
   * a `detached` start becomes a reapable, output-capturing job instead of an
   * orphan daemon. Listed here (rather than pushed after the loop) to hold its
   * REGISTRATION POSITION — tool order is part of the cached prompt prefix.
   * The static array is the no-supervisor fallback.
   */
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
  /**
   * AST-aware structural code search/replace (`ast_grep_*`), backed by the
   * `ast-grep` CLI. Static like the other categories here — no per-session
   * resolver — but the binary is probed lazily (env / @ast-grep/cli / PATH);
   * when unresolved the tools return a clean structured error.
   */
  astGrep: astGrepTools,
  /**
   * Dependency-source research (`clone_dep_source` / `list_cloned_deps`): clone
   * a dependency's source repo into an ignored `.cognia/clonedeps/` workspace so
   * the agent can read library internals. Static category; uses git + fs.
   */
  dependencyResearch: clonedepsTools,
  /**
   * Web page snapshot + reverse-engineering (`web_clone` / `web_clone_convert`):
   * download a live page's HTML + all CSS/JS/image/font assets into a
   * self-contained single file or directory bundle, with optional component
   * extraction + Vue/React/Angular/Svelte/jQuery codegen. The heavy Node-only
   * engine (linkedom / @babel / node:http / node:fs) is vendored under
   * `sidecar/webclone` and runs as an isolated child process. Static category;
   * uses network + fs (approval-gated).
   */
  webclone: webcloneTools,
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
 *   taskStore?: unknown,
 *   cwd?: string,
 *   dispatchPath?: "anthropic" | "ai-sdk",
 * }} [options]
 * @returns {Array<{ name: string, description?: string, inputSchema?: unknown, handler: Function }>}
 */
export function collectCogniaToolDefs({
  enabled,
  lspResolver,
  codeGraphResolver,
  readTracker,
  taskStore,
  cwd,
  dispatchPath,
  bgShells,
  hostRpc,
  sessionId,
  model,
  provider,
} = {}) {
  if (!enabled || typeof enabled !== "object") return []
  const tools = []
  for (const [category, toolList] of Object.entries(TOOLS_BY_CATEGORY)) {
    if (!enabled[category]) continue
    // `process` is the one static category with a session-bound variant; swap
    // it in HERE so it keeps its registration position (see the map entry).
    tools.push(...(category === "process" ? createProcessTools({ bgShells }) : toolList))
  }
  // The `lsp` category is resolver-bound (per-session), so it is not part of
  // the static TOOLS_BY_CATEGORY map — build its tools on demand when the
  // dispatch layer supplies a session LSP resolver.
  if (enabled.lsp && lspResolver) {
    tools.push(...createLspTools(lspResolver))
  }
  // The `codeGraph` category is likewise resolver-bound: its tools wrap a
  // per-session tree-sitter index service supplied by the dispatch layer.
  if (enabled.codeGraph && codeGraphResolver) {
    tools.push(...createCodeGraphTools(codeGraphResolver))
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
    tools.push(
      ...createCoreTools({
        cwd,
        readTracker,
        lspResolver,
        bgShells,
        taskStore,
        hostRpc,
        sessionId,
        model,
        provider,
      })
    )
  } else if (enabled.coreFiles) {
    // Anthropic supplies native file/shell tools, and an AI-SDK session can
    // withhold the file suite when no read tracker is available. Neither path
    // has a native Monitor equivalent, so keep the three supervisor-backed
    // monitor tools available under the same category toggle.
    tools.push(...createMonitorTools({ hostRpc, sessionId }))
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
  codeGraphResolver,
  readTracker,
  taskStore,
  cwd,
  dispatchPath,
  bgShells,
  hostRpc,
  sessionId,
  model,
  provider,
  toolExecutionTimeoutMs,
  maxToolResultTokens,
}) {
  if (!enabled || typeof enabled !== "object") return null
  const tools = collectCogniaToolDefs({
    enabled,
    lspResolver,
    codeGraphResolver,
    readTracker,
    taskStore,
    cwd,
    dispatchPath,
    bgShells,
    hostRpc,
    sessionId,
    model,
    provider,
  })
  if (tools.length === 0) return null
  // Per-tool execution deadline for READ-ONLY built-ins (see
  // `read-only-timeout.mjs`). The Anthropic SDK calls each tool's handler
  // itself, so we wrap the handler at registration time — mirroring the
  // execute-time net the ai-sdk bridge applies (`dispatch/ai-sdk-tools.mjs`).
  // Honour an explicit override (incl. `0` to disable); default the safety net
  // otherwise so a hung read-only tool can't wedge the whole turn.
  const net =
    typeof toolExecutionTimeoutMs === "number"
      ? toolExecutionTimeoutMs
      : DEFAULT_BUILTIN_TOOL_TIMEOUT_MS
  const guarded = wrapDefsWithReadOnlyTimeout(tools, net, READ_ONLY_TOOL_NAMES)
  // Cap oversized tool-result TEXT bodies so a huge bash/grep/read output can't
  // bloat the Anthropic context window (parity with the ai-sdk compaction cap).
  // No-op unless the renderer resolved a `maxToolResultTokens` budget.
  const capped = wrapDefsWithResultCap(guarded, maxToolResultTokens)
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: capped,
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
