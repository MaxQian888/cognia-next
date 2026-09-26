// The built-in tool catalog, read from the metadata JSON the settings UI
// shares, so the sidecar and the UI never disagree about server identity,
// category membership, or which tools are read-only.

import data from "../../../../lib/settings/builtin-tools-data.json" with { type: "json" }

import { qualifiedToolName } from "./names.ts"

/** The in-process MCP server that carries the built-in tools. */
export const BUILTIN_SERVER_NAME: string = data.serverName
export const BUILTIN_SERVER_VERSION: string = data.serverVersion

/** Bare tool names for each category id. */
export const TOOL_NAMES_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(data.categories.map((c) => [c.id, c.tools.map((t) => t.name)]))
)

/**
 * Bare names of the read-only built-in tools (`requiresApproval === false`).
 * Plan mode allows only these and denies every mutating/exec tool, so the
 * non-Anthropic AI-SDK path enforces plan mode instead of trusting the model.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(
    data.categories.flatMap((c) =>
      c.tools.filter((t) => t.requiresApproval === false).map((t) => t.name)
    )
  )
)

/** The SDK-qualified name of a built-in tool: `mcp__cognia-tools__<tool>`. */
export function namespacedName(toolName: string): string {
  return qualifiedToolName(BUILTIN_SERVER_NAME, toolName)
}

/** The per-session resolvers the `lsp` and `codeGraph` categories need. */
export interface CategoryResolvers {
  lspResolver?: unknown
  codeGraphResolver?: unknown
}

/**
 * Return the namespaced tool names for any UNAVAILABLE category. The sidecar
 * pushes these onto `disallowedTools` as defence-in-depth so a stray reference
 * to an absent tool is rejected at the SDK boundary.
 *
 * A category is unavailable when its flag is off OR — for the resolver-bound
 * `lsp` / `codeGraph` categories — when the flag is on but the dispatch layer
 * supplied no resolver. Registration guards on `flag && resolver` while this
 * used to guard on `!flag` alone, so that combination left the tools NEITHER
 * registered NOR denied: a stale `Character.allowedTools` entry or a
 * hallucinated `mcp__cognia-tools__lsp_hover` fell through the SDK boundary
 * unhandled. `lsp` is easy to land in — `opts.lsp` is only populated when
 * `settings.lsp.enabled && cwd && !supportAgent`, while the category flag is
 * `builtinTools.lsp`.
 *
 * Omit `resolvers` to assume both are present (back-compat for callers that do
 * not build resolvers).
 */
export function namesForDisabledCategories(
  enabled: Readonly<Record<string, boolean | undefined>> | null | undefined,
  resolvers?: CategoryResolvers | null
): string[] {
  if (!enabled || typeof enabled !== "object") {
    // No flags — return everything as disallowed.
    return Object.values(TOOL_NAMES_BY_CATEGORY).flat().map(namespacedName)
  }
  const resolverMissing = (category: string) => {
    if (!resolvers || typeof resolvers !== "object") return false
    if (category === "lsp") return !resolvers.lspResolver
    if (category === "codeGraph") return !resolvers.codeGraphResolver
    return false
  }
  const out: string[] = []
  for (const [category, names] of Object.entries(TOOL_NAMES_BY_CATEGORY)) {
    if (!enabled[category] || resolverMissing(category)) {
      for (const n of names) out.push(namespacedName(n))
    }
  }
  return out
}
