/**
 * Per-tool deny rules for a configured MCP server.
 *
 * A server row carries two independent deny axes, and they answer different
 * questions:
 *
 * - `disallowedTools` — exact bare tool names. Pins precisely the tools that
 *   existed when the user flipped them off. A tool the server adds later is
 *   allowed, because the user never saw it.
 * - `disallowedToolPatterns` — globs (`*` = any run, `?` = one character,
 *   matched case-insensitively). Keeps denying tools the server grows later,
 *   which is the only honest reading of "disable everything that writes".
 *
 * Both are *bare* names — the `mcp__<server>__` namespace is stamped on at the
 * send-options seam (`buildMcpDisallowedToolNames`), because the namespace is
 * the runtime server-map key and belongs to the SDK, not to the rule.
 *
 * Everything here is pure so the settings UI, the send path, and the companion
 * write handlers all evaluate rules identically.
 */

/** Characters that must survive into the regexp as literals. */
const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g

export interface McpToolRules {
  disallowedTools?: readonly string[]
  disallowedToolPatterns?: readonly string[]
}

/** Trim, drop blanks, de-duplicate, sort — the shape both fields persist in. */
export function normalizeToolRuleList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort()
}

/** True when the string carries at least one glob metacharacter. */
export function isToolPattern(value: string): boolean {
  return /[*?]/.test(value)
}

/**
 * Compile one glob into an anchored, case-insensitive RegExp. Every character
 * except `*` and `?` is escaped, so a pattern can never smuggle in regexp
 * syntax from a pasted config.
 */
export function toolPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .trim()
    .replace(REGEXP_SPECIALS, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]")
  return new RegExp(`^${source}$`, "i")
}

/** True when `tool` matches the glob. A blank pattern never matches. */
export function matchesToolPattern(tool: string, pattern: string): boolean {
  const trimmed = pattern.trim()
  if (!trimmed) return false
  return toolPatternToRegExp(trimmed).test(tool.trim())
}

/**
 * Which patterns deny this tool. Returned rather than a boolean so the UI can
 * explain *why* a tool is off ("denied by `write_*`") instead of showing a
 * switch the user cannot flip.
 */
export function matchingToolPatterns(tool: string, rules: McpToolRules): string[] {
  return normalizeToolRuleList(rules.disallowedToolPatterns).filter((pattern) =>
    matchesToolPattern(tool, pattern)
  )
}

/** True when the tool name is pinned in the exact deny list. */
export function isToolExplicitlyDenied(tool: string, rules: McpToolRules): boolean {
  const target = tool.trim()
  return normalizeToolRuleList(rules.disallowedTools).some((name) => name === target)
}

/** True when either axis denies the tool. */
export function isToolDenied(tool: string, rules: McpToolRules): boolean {
  return isToolExplicitlyDenied(tool, rules) || matchingToolPatterns(tool, rules).length > 0
}

export type McpToolDenyReason = "allowed" | "explicit" | "pattern"

/** Why a tool is on or off, for the per-tool row in the settings UI. */
export function toolDenyReason(tool: string, rules: McpToolRules): McpToolDenyReason {
  if (isToolExplicitlyDenied(tool, rules)) return "explicit"
  if (matchingToolPatterns(tool, rules).length > 0) return "pattern"
  return "allowed"
}

/**
 * The full set of bare tool names denied for one server: the pinned names,
 * plus every known tool a pattern matches.
 *
 * `knownTools` comes from the capability cache. Patterns therefore deny only
 * tools we have actually seen — an unexpanded pattern denies nothing, which is
 * the fail-open direction, but the alternative (sending a wildcard the SDK
 * treats as a literal name) denies nothing either *and* hides that fact.
 * Discovery is what makes patterns bite; the UI says so.
 */
export function resolveDeniedToolNames(
  rules: McpToolRules,
  knownTools: readonly string[] = []
): string[] {
  const denied = new Set(normalizeToolRuleList(rules.disallowedTools))
  const patterns = normalizeToolRuleList(rules.disallowedToolPatterns)
  if (patterns.length > 0) {
    for (const tool of knownTools) {
      const name = tool.trim()
      if (!name) continue
      if (patterns.some((pattern) => matchesToolPattern(name, pattern))) denied.add(name)
    }
  }
  return [...denied].sort()
}

/**
 * True when `next` denies strictly no less than `prev` — i.e. the edit only
 * tightened privileges.
 *
 * `updateMcpServer` uses this to decide whether a deny-rule edit needs a fresh
 * trust review. Relaxing a rule hands the model back a tool the user had taken
 * away, so that re-opens review; tightening one cannot grant anything, and
 * forcing a review (which disables the server) for flipping a single tool off
 * would make the tool switches unusable.
 *
 * Compared over the expansion against `knownTools` so that swapping three
 * pinned names for the `write_*` that covers them reads as a tightening.
 */
export function isToolRuleTightening(
  prev: McpToolRules,
  next: McpToolRules,
  knownTools: readonly string[] = []
): boolean {
  const universe = new Set<string>([
    ...knownTools.map((tool) => tool.trim()).filter(Boolean),
    ...normalizeToolRuleList(prev.disallowedTools),
    ...normalizeToolRuleList(next.disallowedTools),
  ])
  for (const tool of universe) {
    if (isToolDenied(tool, prev) && !isToolDenied(tool, next)) return false
  }
  // A pattern that survives verbatim is fine; one that disappears could free
  // a not-yet-discovered tool, so treat a dropped pattern as a relaxation.
  const nextPatterns = new Set(normalizeToolRuleList(next.disallowedToolPatterns))
  return normalizeToolRuleList(prev.disallowedToolPatterns).every((pattern) =>
    nextPatterns.has(pattern)
  )
}
