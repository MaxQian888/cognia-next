// Cross-provider deferred tool discovery for the AI SDK dispatch path.
//
// The Anthropic Agent SDK natively understands `alwaysLoad` and ToolSearch.
// AI SDK providers instead receive one flat tool map, but AI SDK 6 exposes
// `prepareStep({ ... }) → { activeTools }`. This controller uses that seam to
// keep only essential tools resident, then activates permitted tools after the
// model discovers them through ToolSearch. It only sees the already-filtered,
// permission-gated tool map, so discovery cannot reintroduce denied tools.

import { tool } from "ai"
import { z } from "zod"

export const AI_SDK_TOOL_SEARCH_NAME = "ToolSearch"

/** @type {WeakMap<object, { serverName?: string, alwaysLoad?: boolean }>} */
const TOOL_SOURCE = new WeakMap()

/** Attach non-serializing discovery metadata to one AI SDK tool object. */
export function markAiSdkToolSource(aiTool, source) {
  if (aiTool && (typeof aiTool === "object" || typeof aiTool === "function")) {
    TOOL_SOURCE.set(aiTool, { ...source })
  }
  return aiTool
}

function inferredServerName(toolName) {
  const match = /^mcp__(.+?)__/.exec(toolName)
  return match?.[1]
}

function configuredToolMatches(configured, name, source) {
  if (configured.has(name)) return true
  return source?.serverName ? configured.has(`mcp__${source.serverName}__${name}`) : false
}

function scoreCandidate(name, description, query) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 0
  const lowerName = name.toLowerCase()
  const haystack = `${lowerName} ${String(description ?? "").toLowerCase()}`
  if (lowerName === normalized) return 1_000
  if (lowerName.includes(normalized)) return 500

  const terms = [...new Set(normalized.split(/[^a-z0-9_:-]+/).filter(Boolean))]
  const hits = terms.filter((term) => haystack.includes(term))
  if (hits.length === 0) return 0
  const nameHits = hits.filter((term) => lowerName.includes(term)).length
  return hits.length * 20 + nameHits * 10 + (hits.length === terms.length ? 100 : 0)
}

function searchCandidates(tools, query, limit) {
  return Object.entries(tools)
    .filter(([name]) => name !== AI_SDK_TOOL_SEARCH_NAME)
    .map(([name, value]) => ({
      name,
      description: String(value?.description ?? ""),
      score: scoreCandidate(name, value?.description, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * Build one session-scoped ToolSearch controller.
 *
 * @param {{ tools: Record<string, any>, sendOptions?: Record<string, any> }} options
 * @returns {null | {
 *   tools: Record<string, any>,
 *   prepareStep: () => { activeTools: string[] },
 *   activeToolNames: () => string[],
 * }}
 */
export function createAiSdkToolSearchController({ tools, sendOptions = {} }) {
  if (sendOptions.toolSearchEnabled !== true) return null

  const available = { ...(tools ?? {}) }
  // ToolSearch is bridge infrastructure and intentionally replaces a same-name
  // contributed tool. The name is reserved by the Agent runtime when deferred
  // loading is enabled, matching Claude Code's canonical discovery surface.
  delete available[AI_SDK_TOOL_SEARCH_NAME]
  const availableNames = Object.keys(available).sort()
  const alwaysLoadServers = new Set(
    Array.isArray(sendOptions.alwaysLoadServers) ? sendOptions.alwaysLoadServers : []
  )
  const alwaysLoadTools = new Set(
    Array.isArray(sendOptions.alwaysLoadTools) ? sendOptions.alwaysLoadTools : []
  )
  const active = new Set([AI_SDK_TOOL_SEARCH_NAME])

  for (const name of availableNames) {
    const value = available[name]
    const source = TOOL_SOURCE.get(value) ?? { serverName: inferredServerName(name) }
    if (
      source.alwaysLoad === true ||
      (source.serverName && alwaysLoadServers.has(source.serverName)) ||
      configuredToolMatches(alwaysLoadTools, name, source)
    ) {
      active.add(name)
    }
  }

  const searchTool = tool({
    description:
      "Search tools that are available to this Agent session but deferred from the current prompt. Calling ToolSearch activates the returned tools for later steps in this session. Use select:<tool_name>[,<tool_name>] for exact activation, or a short capability query for ranked discovery.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Capability query or exact selector such as "select:write,git_commit".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Maximum matches to activate and return (default 5, max 8)."),
    }),
    execute: async ({ query, limit = 5 }) => {
      const exact = /^select\s*:/i.test(query)
      let matches
      let missing = []
      if (exact) {
        const requested = [
          ...new Set(
            query
              .replace(/^select\s*:/i, "")
              .split(/[\s,]+/)
              .map((name) => name.trim())
              .filter(Boolean)
          ),
        ]
        matches = requested
          .filter((name) => Object.hasOwn(available, name))
          .sort()
          .slice(0, limit)
          .map((name) => ({ name, description: String(available[name]?.description ?? "") }))
        missing = requested.filter((name) => !Object.hasOwn(available, name)).sort()
      } else {
        matches = searchCandidates(available, query, limit).map(
          ({ score: _score, ...entry }) => entry
        )
      }

      const activated = matches.map((entry) => entry.name).sort()
      for (const name of activated) active.add(name)
      return JSON.stringify({ query, matches, activated, ...(missing.length ? { missing } : {}) })
    },
  })

  const allTools = Object.fromEntries(
    [[AI_SDK_TOOL_SEARCH_NAME, searchTool], ...Object.entries(available)].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  )
  const activeToolNames = () => Object.keys(allTools).filter((name) => active.has(name))

  return {
    tools: allTools,
    activeToolNames,
    prepareStep: () => ({ activeTools: activeToolNames() }),
  }
}
