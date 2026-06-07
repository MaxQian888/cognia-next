/**
 * Pure editing helpers for the user-facing tool-permission Ruleset
 * (`AppSettings.agentPermissions.toolRules`). Kept separate from the
 * resolver (`ruleset.ts`) so the settings UI stays thin and the helpers are
 * trivially unit-testable.
 *
 * `deterministicRulesetSort` is load-bearing: the merged ruleset is
 * serialized into `SendOptions.permissionRuleset` every turn, and provider
 * prompt-cache prefix matching requires byte-identical serialization across
 * turns — so tool keys and glob keys are emitted in sorted order.
 */

import type { PermissionVerdict, Ruleset, ToolRules } from "./ruleset"

/** Set (add or update) one `pattern → verdict` rule under a tool key. */
export function setToolRule(
  ruleset: Ruleset | undefined,
  tool: string,
  pattern: string,
  verdict: PermissionVerdict
): Ruleset {
  const out: Ruleset = { ...(ruleset ?? {}) }
  const existing = out[tool]
  const rules: ToolRules =
    existing && typeof existing === "object" ? { ...existing } : ({} as ToolRules)
  // A previous flat-verdict entry is preserved as a `*` rule so upgrading a
  // tool from "one verdict" to "per-pattern rules" doesn't drop intent.
  if (typeof existing === "string") rules["*"] = existing
  rules[pattern] = verdict
  out[tool] = rules
  return out
}

/** Remove one pattern rule; drops the tool key when no rules remain. */
export function removeToolRule(
  ruleset: Ruleset | undefined,
  tool: string,
  pattern: string
): Ruleset {
  const out: Ruleset = { ...(ruleset ?? {}) }
  const existing = out[tool]
  if (!existing || typeof existing === "string") return out
  const rules: ToolRules = { ...existing }
  delete rules[pattern]
  if (Object.keys(rules).length === 0) delete out[tool]
  else out[tool] = rules
  return out
}

/** List `{ tool, pattern, verdict }` rows for rendering, sorted. */
export function listRules(
  ruleset: Ruleset | undefined
): Array<{ tool: string; pattern: string; verdict: PermissionVerdict }> {
  const rows: Array<{ tool: string; pattern: string; verdict: PermissionVerdict }> = []
  for (const [tool, entry] of Object.entries(ruleset ?? {})) {
    if (typeof entry === "string") {
      rows.push({ tool, pattern: "*", verdict: entry })
    } else {
      for (const [pattern, verdict] of Object.entries(entry)) {
        rows.push({ tool, pattern, verdict })
      }
    }
  }
  rows.sort((a, b) =>
    a.tool === b.tool ? a.pattern.localeCompare(b.pattern) : a.tool.localeCompare(b.tool)
  )
  return rows
}

/**
 * Re-key the ruleset with sorted tool keys and sorted glob keys so identical
 * rulesets always serialize byte-identically (prompt-cache stability).
 */
export function deterministicRulesetSort(ruleset: Ruleset): Ruleset {
  const out: Ruleset = {}
  for (const tool of Object.keys(ruleset).sort()) {
    const entry = ruleset[tool]
    if (typeof entry === "string") {
      out[tool] = entry
    } else {
      const rules: ToolRules = {} as ToolRules
      for (const glob of Object.keys(entry).sort()) rules[glob] = entry[glob]
      out[tool] = rules
    }
  }
  return out
}
