/**
 * Per-session memory of what the user REFUSED.
 *
 * Cognia remembered every "Allow always" forever and every "Deny" not at all.
 * So a refusal bought nothing: the same call asked again on the next turn, and
 * if anything widened in between — a new `alwaysAllowTools` entry, a broader
 * rule authored in Settings — the thing the user had just refused started
 * auto-approving. A decision that only counts when it says yes is not a
 * decision.
 *
 * A refusal here is remembered for the SESSION and projected into the
 * serialized `permissionRuleset` as an explicit `deny`. That placement is what
 * makes it outrank a later widening: `canUseTool` in
 * `sidecar/dispatch/anthropic.mjs` returns on an explicit deny BEFORE it
 * consults `alwaysAllowTools`, so a remembered refusal cannot be undone by a
 * name-level grant.
 *
 * Refusals are scoped exactly the way grants are — through
 * `deriveAllowRuleFromApproval`, so `Deny` on `git push --force` refuses that
 * command and not the whole `git` family. When a call carries no useful target
 * the refusal lands at tool-name level, which is the only scope available.
 *
 * **Saturation fails closed.** Past the cap the module stops being able to
 * promise "everything you refused is still refused", so instead of quietly
 * forgetting the oldest refusal it marks the session saturated, and
 * {@link applySessionDenials} strips every auto-approval from that session:
 * no `alwaysAllowTools`, no `allow` rules. The session degrades to asking
 * about everything, which is the honest failure mode — silently dropping a
 * refusal is not.
 *
 * In-memory and per-process on purpose: a refusal is a statement about this
 * conversation, not a setting. Settings → Agent → Permissions is where a
 * durable deny is authored.
 */

import type { PermissionVerdict, Ruleset, ToolRules } from "./ruleset"
import { deriveAllowRuleFromApproval } from "./approval-rule"

/** Refusals kept per session before the session fails closed. */
export const MAX_DENIALS_PER_SESSION = 512

/** Sessions tracked before the least-recently-touched one is evicted. */
export const MAX_TRACKED_SESSIONS = 64

interface SessionRecord {
  /** `tool` → set of refused patterns. A bare tool-name refusal uses `null`. */
  byTool: Map<string, Set<string> | null>
  /** Total refused entries, for the cap. */
  count: number
  /** True once the cap was hit; the session then refuses to auto-approve at all. */
  saturated: boolean
}

const sessions = new Map<string, SessionRecord>()

function touch(sessionId: string): SessionRecord {
  const existing = sessions.get(sessionId)
  if (existing) {
    // Re-insert so iteration order is least-recently-touched first.
    sessions.delete(sessionId)
    sessions.set(sessionId, existing)
    return existing
  }
  const record: SessionRecord = { byTool: new Map(), count: 0, saturated: false }
  sessions.set(sessionId, record)
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next()
    if (oldest.done) break
    sessions.delete(oldest.value)
  }
  return record
}

/**
 * Remember that the user refused this exact call.
 *
 * @param sessionId conversation the refusal belongs to
 * @param toolName  tool as reported in the approval request
 * @param input     the tool-call input the user was shown
 */
export function rememberDenial(sessionId: string, toolName: string, input: unknown): void {
  if (!sessionId || !toolName) return
  const record = touch(sessionId)
  if (record.saturated) return

  const scoped = deriveAllowRuleFromApproval(toolName, input)
  const tool = scoped?.tool ?? toolName
  const pattern = scoped?.pattern ?? null

  const existing = record.byTool.get(tool)
  if (existing === null) return // already refused at tool-name level; nothing narrower to add
  if (pattern === null) {
    // A tool-name refusal subsumes every pattern refusal for that tool.
    record.count -= existing?.size ?? 0
    record.byTool.set(tool, null)
    record.count += 1
  } else {
    const patterns = existing ?? new Set<string>()
    if (patterns.has(pattern)) return
    patterns.add(pattern)
    record.byTool.set(tool, patterns)
    record.count += 1
  }

  if (record.count > MAX_DENIALS_PER_SESSION) record.saturated = true
}

/** Forget everything refused in a session (the conversation is gone). */
export function clearSessionDenials(sessionId: string): void {
  sessions.delete(sessionId)
}

/** True when the session hit the cap and can no longer auto-approve anything. */
export function isSessionSaturated(sessionId: string): boolean {
  return sessions.get(sessionId)?.saturated === true
}

/** How many refusals are remembered for a session. */
export function countSessionDenials(sessionId: string): number {
  return sessions.get(sessionId)?.count ?? 0
}

/** The refusals for a session as a ruleset layer, or `undefined` when there are none. */
export function denialRuleset(sessionId: string): Ruleset | undefined {
  const record = sessions.get(sessionId)
  if (!record || record.byTool.size === 0) return undefined
  const out: Ruleset = {}
  for (const [tool, patterns] of record.byTool) {
    if (patterns === null) {
      out[tool] = "deny"
      continue
    }
    const rules: ToolRules = {}
    for (const pattern of patterns) rules[pattern] = "deny"
    out[tool] = rules
  }
  return out
}

/** Drop every `allow` from a ruleset, keeping `ask` and `deny`. */
function withoutAllows(ruleset: Ruleset): Ruleset {
  const out: Ruleset = {}
  for (const [tool, entry] of Object.entries(ruleset)) {
    if (typeof entry === "string") {
      if (entry !== "allow") out[tool] = entry
      continue
    }
    const kept: ToolRules = {}
    for (const [glob, verdict] of Object.entries(entry)) {
      if (verdict !== "allow") kept[glob] = verdict as PermissionVerdict
    }
    if (Object.keys(kept).length > 0) out[tool] = kept
  }
  return out
}

export interface SessionPermissionInputs {
  ruleset: Ruleset
  alwaysAllowTools?: string[]
}

/**
 * Fold a session's remembered refusals into the permissions it is about to
 * send.
 *
 * Normal case: the refusals become explicit `deny` rules layered on top, which
 * the sidecar honours ahead of any grant. Saturated case: every auto-approval
 * is stripped as well, so the session asks about everything rather than
 * pretending a refusal it can no longer track is still in force.
 */
export function applySessionDenials(
  sessionId: string | undefined,
  inputs: SessionPermissionInputs
): SessionPermissionInputs {
  if (!sessionId) return inputs
  const denials = denialRuleset(sessionId)
  if (!denials) return inputs

  const saturated = isSessionSaturated(sessionId)
  const base = saturated ? withoutAllows(inputs.ruleset) : inputs.ruleset
  const ruleset: Ruleset = { ...base }
  for (const [tool, entry] of Object.entries(denials)) {
    const prev = ruleset[tool]
    if (typeof entry === "string" || typeof prev === "string" || prev === undefined) {
      ruleset[tool] = entry
      continue
    }
    ruleset[tool] = { ...prev, ...entry }
  }
  return {
    ruleset,
    ...(saturated
      ? {}
      : inputs.alwaysAllowTools
        ? { alwaysAllowTools: inputs.alwaysAllowTools }
        : {}),
  }
}

/** Test seam — drops all tracked sessions. */
export function __resetSessionDenialsForTesting(): void {
  sessions.clear()
}
