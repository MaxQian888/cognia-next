/**
 * Replay checks over past sessions (ADR-0238 §8.4): is each rule actually
 * followed?
 *
 * Deterministic and offline — no model call. For every check it counts
 * opportunities (a call the rule applies to) and whether the rule held, keeps
 * a few samples of each outcome for the user to inspect, and drops samples the
 * user labeled a false match so a loose check can be corrected without being
 * re-derived. Two derived signals feed findings:
 *
 * - a rule with opportunities but a low follow rate is not working as prose
 *   and is a candidate for enforcement;
 * - a rule that holds early in long sessions and breaks late is losing to
 *   context dilution — position, not wording, is the likely fix.
 *
 * A rule that never had an opportunity across the window is reported too:
 * either the window is too small or the rule is obsolete.
 */

import { compileMatcher, type CompiledMatcher, type RuleCheck } from "./checks"
import type { SessionEvents, ToolEvent } from "./events"

export type Outcome = "followed" | "violated"

export interface CheckSample {
  sessionId: string
  messageId: string
  turn: number
  order: number
  outcome: Outcome
  /** The call, as a short label (command or first path). */
  call: string
}

export interface CheckResult {
  checkId: string
  sessionsScanned: number
  /** Sessions with at least one opportunity. */
  sessionsTriggered: number
  opportunities: number
  followed: number
  violated: number
  /** Samples the user labeled a false match, excluded from the counts. */
  excluded: number
  samples: CheckSample[]
  /** Violation rate in the first and second half of sessions' turns, when both have data. */
  dilution?: { early: number; late: number; earlyOpportunities: number; lateOpportunities: number }
  /** True when the check could not run (bad pattern after a manual edit). */
  invalid?: boolean
}

/** Samples kept per outcome. */
export const SAMPLES_PER_OUTCOME = 5
/** A follow rate under this, over at least {@link MIN_OPPORTUNITIES}, is "not followed". */
export const LOW_ADHERENCE = 0.6
export const MIN_OPPORTUNITIES = 3
/** Late violation rate this many times the early one reads as dilution. */
export const DILUTION_RATIO = 1.5

export function sampleKey(checkId: string, sessionId: string, order: number): string {
  return `${checkId}|${sessionId}|${order}`
}

function callLabel(event: ToolEvent): string {
  const text = event.command ?? event.paths[0] ?? event.tool
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function inScope(check: RuleCheck, a: ToolEvent, b: ToolEvent): boolean {
  return check.scope === "session" || a.turn === b.turn
}

interface Matchers {
  trigger: CompiledMatcher
  expect?: CompiledMatcher
}

function outcomeOf(
  check: RuleCheck,
  matchers: Matchers,
  events: readonly ToolEvent[],
  index: number
): Outcome {
  const event = events[index]!
  if (check.kind === "forbid") return "violated"
  const expect = matchers.expect!
  if (check.kind === "require-after") {
    for (let next = index + 1; next < events.length; next++) {
      const later = events[next]!
      if (!inScope(check, event, later)) break
      if (expect.matches(later)) return "followed"
    }
    return "violated"
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    const earlier = events[previous]!
    if (!inScope(check, earlier, event)) break
    if (expect.matches(earlier)) return "followed"
  }
  return "violated"
}

export interface BacktestInput {
  checks: readonly RuleCheck[]
  sessions: readonly SessionEvents[]
  /** Sample keys ({@link sampleKey}) the user labeled a false match. */
  falseMatches?: ReadonlySet<string>
  roots?: readonly string[]
}

export function runBacktest(input: BacktestInput): CheckResult[] {
  const falseMatches = input.falseMatches ?? new Set<string>()
  return input.checks.map((check) => {
    const result: CheckResult = {
      checkId: check.id,
      sessionsScanned: input.sessions.length,
      sessionsTriggered: 0,
      opportunities: 0,
      followed: 0,
      violated: 0,
      excluded: 0,
      samples: [],
    }
    let matchers: Matchers
    try {
      matchers = {
        trigger: compileMatcher(check.trigger, input.roots),
        ...(check.expect ? { expect: compileMatcher(check.expect, input.roots) } : {}),
      }
      if (check.kind !== "forbid" && !matchers.expect) throw new Error("missing expectation")
    } catch {
      return { ...result, invalid: true }
    }
    const kept: Record<Outcome, number> = { followed: 0, violated: 0 }
    const halves = { early: [0, 0], late: [0, 0] } // [opportunities, violations]
    for (const session of input.sessions) {
      let triggered = false
      session.events.forEach((event, index) => {
        if (!matchers.trigger.matches(event)) return
        if (falseMatches.has(sampleKey(check.id, session.sessionId, event.order))) {
          result.excluded++
          return
        }
        triggered = true
        const outcome = outcomeOf(check, matchers, session.events, index)
        result.opportunities++
        result[outcome]++
        if (session.turns >= 4) {
          const half = event.turn < session.turns / 2 ? halves.early : halves.late
          half[0]!++
          if (outcome === "violated") half[1]!++
        }
        if (kept[outcome] < SAMPLES_PER_OUTCOME) {
          kept[outcome]++
          result.samples.push({
            sessionId: session.sessionId,
            messageId: event.messageId,
            turn: event.turn,
            order: event.order,
            outcome,
            call: callLabel(event),
          })
        }
      })
      if (triggered) result.sessionsTriggered++
    }
    const [earlyOps, earlyViolations] = halves.early as [number, number]
    const [lateOps, lateViolations] = halves.late as [number, number]
    if (earlyOps > 0 && lateOps > 0) {
      result.dilution = {
        early: earlyViolations / earlyOps,
        late: lateViolations / lateOps,
        earlyOpportunities: earlyOps,
        lateOpportunities: lateOps,
      }
    }
    return result
  })
}

/** Share of opportunities where the rule held; `forbid` counts clean triggered sessions as nothing to measure. */
export function followRate(result: CheckResult): number | undefined {
  return result.opportunities > 0 ? result.followed / result.opportunities : undefined
}

export type AdherenceVerdict =
  "followed" | "not-followed" | "never-triggered" | "too-few" | "invalid"

export function verdictOf(check: RuleCheck, result: CheckResult): AdherenceVerdict {
  if (result.invalid) return "invalid"
  if (result.opportunities === 0) return "never-triggered"
  // Any `forbid` hit is a violation; for the rest, judge the rate once there is enough data.
  if (check.kind === "forbid") return result.violated > 0 ? "not-followed" : "followed"
  if (result.opportunities < MIN_OPPORTUNITIES) return "too-few"
  return (followRate(result) ?? 1) < LOW_ADHERENCE ? "not-followed" : "followed"
}

/** Late breakage that looks like the rule loses weight as the conversation grows. */
export function showsDilution(result: CheckResult): boolean {
  const dilution = result.dilution
  if (!dilution || dilution.lateOpportunities < MIN_OPPORTUNITIES) return false
  if (dilution.late === 0) return false
  return dilution.early === 0
    ? dilution.late >= 0.5
    : dilution.late >= dilution.early * DILUTION_RATIO
}
