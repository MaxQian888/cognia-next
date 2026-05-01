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

import { fileExtrasTools } from "./file-extras.mjs"
import { gitTools } from "./git.mjs"
import { processTools } from "./process.mjs"
import { environmentTools } from "./environment.mjs"
import { shellAdvancedTools } from "./shell-advanced.mjs"

/** @type {Record<string, ReadonlyArray<unknown>>} */
const TOOLS_BY_CATEGORY = {
  fileExtras: fileExtrasTools,
  git: gitTools,
  process: processTools,
  environment: environmentTools,
  shellAdvanced: shellAdvancedTools,
}

/**
 * Bare tool names for each category — read from the shared metadata JSON so
 * the sidecar and the UI never disagree about category membership.
 * @type {Record<string, ReadonlyArray<string>>}
 */
export const TOOL_NAMES_BY_CATEGORY = Object.freeze(
  Object.fromEntries(data.categories.map((c) => [c.id, c.tools.map((t) => t.name)]))
)

export const SERVER_NAME = data.serverName
export const SERVER_VERSION = data.serverVersion

/**
 * Build the in-process SDK MCP server.
 *
 * @param {object} options
 * @param {{ fileExtras?: boolean, git?: boolean, process?: boolean, environment?: boolean, shellAdvanced?: boolean }} options.enabled
 * @returns {ReturnType<typeof createSdkMcpServer> | null}
 */
export function buildCogniaToolsServer({ enabled }) {
  if (!enabled || typeof enabled !== "object") return null
  const tools = []
  for (const [category, toolList] of Object.entries(TOOLS_BY_CATEGORY)) {
    if (enabled[category]) {
      tools.push(...toolList)
    }
  }
  if (tools.length === 0) return null
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
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
