/**
 * Settings-level dispatch allowlist/denylist over PROJECTED subagent ids
 * (`Explore`, `myplugin:reviewer`, `template:*`) — the OpenCode
 * `permission.task` semantics: a denied id never enters the `dispatch_agent`
 * enum (the model can't even try it) and is refused fail-closed at dispatch
 * time (the enum can drift within a session).
 *
 * Pure — used by the renderer enum builder (build-options) and the dispatch
 * guard (`dispatchSubagent`). The CLI host has no access to renderer Dexie
 * settings, so it enforces only the `disabled` flag, not this settings-level
 * policy. Reuses the shared glob machinery from `lib/claude/permissions/ruleset`
 * (NOT a new matcher): most-specific-match wins; `ask` is reserved and treated
 * as `allow` in v1. Default allow when no rule matches or no rules configured.
 */

import { matchGlob, type ToolRules } from "@/lib/claude/permissions/ruleset"

export type SubagentDispatchVerdict = "allow" | "deny"

/** Longer non-wildcard prefix ⇒ more specific (same convention as ruleset). */
function specificity(glob: string): number {
  const starIndex = glob.indexOf("*")
  return starIndex === -1 ? glob.length + 1 : starIndex
}

/**
 * Resolve the dispatch verdict for a projected subagent id against the
 * user's `agentPermissions.subagentRules`.
 */
export function resolveSubagentDispatchVerdict(
  rules: ToolRules | undefined,
  subagentId: string
): SubagentDispatchVerdict {
  if (!rules) return "allow"
  let best: { glob: string; verdict: SubagentDispatchVerdict } | undefined
  for (const [glob, verdict] of Object.entries(rules)) {
    if (!matchGlob(glob, subagentId)) continue
    // `ask` is reserved for a future dispatch-approval gate; v1 ≡ allow.
    const resolved: SubagentDispatchVerdict = verdict === "deny" ? "deny" : "allow"
    if (!best || specificity(glob) > specificity(best.glob)) {
      best = { glob, verdict: resolved }
    }
  }
  return best?.verdict ?? "allow"
}

/** Convenience: is this id dispatchable under the configured rules? */
export function isSubagentDispatchAllowed(
  rules: ToolRules | undefined,
  subagentId: string
): boolean {
  return resolveSubagentDispatchVerdict(rules, subagentId) === "allow"
}
