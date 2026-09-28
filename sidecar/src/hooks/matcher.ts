import type { HookInput, HookDeps, AgentIdentity } from "./kernel/types.ts"

// --- Matcher (port of crates/cognia-hooks/src/lib.rs:matcher_matches) -----------

/**
 * Test whether a hook group's matcher applies to `target`.
 *   - omitted / "*" / empty → match all
 *   - alphanumeric + `_` + `|` → exact-string-or-pipe-set match
 *   - anything else → JS regex (unanchored)
 */
const matcherRegexCache = new Map<string, RegExp | null>()

export function matcherMatches(matcher: unknown, target: string, narrowExactSet = false) {
  if (matcher == null) return true
  const m = String(matcher).trim()
  if (m === "" || m === "*") return true
  const exactPattern = narrowExactSet ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\-, |]+$/
  if (exactPattern.test(m)) {
    const separator = narrowExactSet ? /\|/ : /[|,]/
    return m.split(separator).some((alt) => alt.trim() === target)
  }
  // Compiled once per pattern — this runs for every tool call of the session.
  let re = matcherRegexCache.get(m)
  if (re === undefined) {
    try {
      re = new RegExp(m)
    } catch {
      re = null
    }
    matcherRegexCache.set(m, re)
  }
  return re ? re.test(target) : false
}

/**
 * Resolve the agent identity for one hook fire.
 *
 * cognia does not launch the SDK with `--agent`, so the SDK only fills
 * `agent_id` / `agent_type` INSIDE a Task-dispatched subagent — every other
 * turn (a teammate, a plan step, a connector auto-reply) is indistinguishable
 * from a plain chat turn as far as the SDK is concerned. So the session's own
 * identity is injected host-side via `deps`, and the SDK's subagent identity
 * layers on top when present: a Task subagent spawned inside a teammate turn is
 * a subagent, not a teammate.
 */
export function resolveAgentIdentity(
  input: HookInput | undefined,
  deps: HookDeps = {}
): AgentIdentity {
  const sdkAgentId = typeof input?.agent_id === "string" ? input.agent_id : undefined
  const sdkAgentType = typeof input?.agent_type === "string" ? input.agent_type : undefined
  const kind = sdkAgentId ? "subagent" : deps.agentKind
  const agentRef = sdkAgentType ?? sdkAgentId ?? deps.agentRef
  return {
    ...(kind ? { agent_kind: kind } : {}),
    ...(agentRef ? { agent_ref: agentRef } : {}),
  }
}

/**
 * Test a group's `agents` selector against the resolved identity. Absent
 * selector → match all, so every pre-existing config is untouched. A present
 * selector matches when it applies to EITHER `agent_kind` or `agent_ref`.
 *
 * An unidentified event never matches a present selector: a hook that asked to
 * be narrowed must not fire on a turn whose agent we cannot name.
 */
export function agentsMatch(selector: unknown, identity?: AgentIdentity) {
  if (selector == null) return true
  const sel = String(selector).trim()
  if (sel === "" || sel === "*") return true
  return [identity?.agent_kind, identity?.agent_ref]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .some((target) => matcherMatches(sel, target))
}
