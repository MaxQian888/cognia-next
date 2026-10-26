/**
 * Enforcement: a rule the backtest showed is not followed, turned into a
 * tool hook the user adopted (ADR-0238 §9) — Cognia's Hookify.
 *
 * Rules run in the plugin's own `onPreToolUse` / `onPostToolUse`, scoped to a
 * workspace or to every session, in one of two modes:
 *
 * - `block` denies the call before it runs and tells the model why
 *   (`forbid`, and `require-before` when the expectation has not happened
 *   in scope); a `require-after` rule cannot block a call that has not been
 *   made, so it always reminds.
 * - `remind` lets the call run and appends the rule to its text result.
 *
 * This module is pure: it keeps per-session call history (bounded) and
 * decides; the hook binding renders the wording and reads the session's
 * workspace.
 */

import { compileMatcher, type CompiledMatcher, type RuleCheck } from "../adherence/checks"
import type { NormalizedToolCall } from "../adherence/events"

export type EnforcementMode = "block" | "remind"

export interface EnforcementRule {
  id: string
  check: RuleCheck
  mode: EnforcementMode
  /** The workspace whose sessions it applies to; `null` applies to every session. */
  workspaceId: string | null
  enabled: boolean
  createdAt: number
  /** The finding it was adopted from, when there was one. */
  findingId?: string
}

/** Calls remembered per session for `require-before` / `require-after`. */
export const MAX_HISTORY = 200
/** Sessions tracked at once; the least recently active is dropped. */
export const MAX_TRACKED_SESSIONS = 50

interface HistoryEntry {
  turn: number
  call: NormalizedToolCall
}

interface SessionState {
  turn: number
  history: HistoryEntry[]
  /** `require-after` rules waiting for their expectation: rule id → turn opened. */
  pending: Map<string, number>
}

interface CompiledRule {
  rule: EnforcementRule
  trigger: CompiledMatcher
  expect?: CompiledMatcher
}

export interface PreDecision {
  /** The rule that blocks the call, when one does. */
  blockedBy?: EnforcementRule
}

export interface PostDecision {
  /** Rules to remind the model of, in order. */
  reminders: EnforcementRule[]
}

export class EnforcementEngine {
  private readonly sessions = new Map<string, SessionState>()
  private compiled: CompiledRule[] = []

  /** Replace the rule set; invalid rules are skipped (and reported by the caller's validation). */
  setRules(rules: readonly EnforcementRule[], roots: readonly string[] = []): void {
    const next: CompiledRule[] = []
    for (const rule of rules) {
      if (!rule.enabled) continue
      try {
        next.push({
          rule,
          trigger: compileMatcher(rule.check.trigger, roots),
          ...(rule.check.expect ? { expect: compileMatcher(rule.check.expect, roots) } : {}),
        })
      } catch {
        // A rule whose pattern no longer compiles is inert; the UI shows it as invalid.
      }
    }
    this.compiled = next
  }

  hasRules(): boolean {
    return this.compiled.length > 0
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state) {
      // Re-insert to keep the map ordered by recency.
      this.sessions.delete(sessionId)
    } else {
      state = { turn: 0, history: [], pending: new Map() }
    }
    this.sessions.set(sessionId, state)
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return state
  }

  /** A user message starts a new turn. */
  onPrompt(sessionId: string): void {
    this.state(sessionId).turn++
  }

  private applicable(workspaceId: string | null | undefined): CompiledRule[] {
    return this.compiled.filter(
      (entry) => entry.rule.workspaceId === null || entry.rule.workspaceId === workspaceId
    )
  }

  private seenInScope(
    state: SessionState,
    rule: EnforcementRule,
    matcher: CompiledMatcher
  ): boolean {
    return state.history.some(
      (entry) =>
        (rule.check.scope === "session" || entry.turn === state.turn) && matcher.matches(entry.call)
    )
  }

  /** Before a call runs. A call that is not blocked is recorded. */
  pre(
    sessionId: string,
    workspaceId: string | null | undefined,
    call: NormalizedToolCall
  ): PreDecision {
    const state = this.state(sessionId)
    for (const entry of this.applicable(workspaceId)) {
      if (entry.rule.mode !== "block" || !entry.trigger.matches(call)) continue
      if (entry.rule.check.kind === "forbid") return { blockedBy: entry.rule }
      if (
        entry.rule.check.kind === "require-before" &&
        entry.expect &&
        !this.seenInScope(state, entry.rule, entry.expect)
      ) {
        return { blockedBy: entry.rule }
      }
    }
    state.history.push({ turn: state.turn, call })
    if (state.history.length > MAX_HISTORY)
      state.history.splice(0, state.history.length - MAX_HISTORY)
    return {}
  }

  /** After a call ran. */
  post(
    sessionId: string,
    workspaceId: string | null | undefined,
    call: NormalizedToolCall
  ): PostDecision {
    const state = this.state(sessionId)
    const reminders: EnforcementRule[] = []
    // A turn-scoped `require-after` closes with its turn.
    for (const [ruleId, turn] of state.pending) {
      const rule = this.compiled.find((entry) => entry.rule.id === ruleId)?.rule
      if (!rule || (rule.check.scope === "turn" && turn !== state.turn))
        state.pending.delete(ruleId)
    }
    // `pre` recorded this call last; the history before it is what "before" means.
    const last = state.history[state.history.length - 1]
    const earlier = last && sameCall(last.call, call) ? state.history.slice(0, -1) : state.history
    for (const entry of this.applicable(workspaceId)) {
      const { rule } = entry
      // A pending `require-after` is satisfied by its expectation.
      if (rule.check.kind === "require-after" && entry.expect?.matches(call)) {
        state.pending.delete(rule.id)
      }
      if (!entry.trigger.matches(call)) continue
      if (rule.check.kind === "forbid") {
        if (rule.mode === "remind") reminders.push(rule)
      } else if (rule.check.kind === "require-before") {
        // Block mode stopped it in `pre` already when the expectation was missing.
        const met =
          entry.expect !== undefined &&
          earlier.some(
            (past) =>
              (rule.check.scope === "session" || past.turn === state.turn) &&
              entry.expect!.matches(past.call)
          )
        if (!met && rule.mode === "remind") reminders.push(rule)
      } else if (!state.pending.has(rule.id)) {
        // Remind once per opening, not on every matching edit of a batch.
        state.pending.set(rule.id, state.turn)
        reminders.push(rule)
      }
    }
    return { reminders }
  }

  /** Forget a session (deleted, or the plugin is going away). */
  forget(sessionId?: string): void {
    if (sessionId === undefined) this.sessions.clear()
    else this.sessions.delete(sessionId)
  }
}

function sameCall(a: NormalizedToolCall, b: NormalizedToolCall): boolean {
  return (
    a.tool === b.tool &&
    a.command === b.command &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, index) => path === b.paths[index])
  )
}

/** `<surface>:<line>`, the location wording uses. */
export function ruleLocation(rule: EnforcementRule): string {
  return `${rule.check.rule.surfaceName}:${rule.check.rule.startLine}`
}

/** The plain-text body of a tool result, or `null` when it is not text the model reads as such. */
export function toolResultText(result: unknown): string | null {
  if (typeof result === "string") return result
  const blocks = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : null
  if (!blocks || blocks.length === 0) return null
  const texts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== "object") return null
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== "text" || typeof text !== "string") return null
    texts.push(text)
  }
  return texts.join("\n")
}

export function validateRule(rule: EnforcementRule): boolean {
  try {
    compileMatcher(rule.check.trigger)
    if (rule.check.expect) compileMatcher(rule.check.expect)
    return rule.check.kind === "forbid" || rule.check.expect !== undefined
  } catch {
    return false
  }
}
