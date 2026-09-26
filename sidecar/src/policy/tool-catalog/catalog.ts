// The built-in tool catalog, read from the metadata JSON the settings UI
// shares, so the sidecar and the UI never disagree about server identity,
// category membership, or which tools are read-only.

import data from "../../../../lib/settings/builtin-tools-data.json" with { type: "json" }

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
