/**
 * Adherence results as findings (ADR-0238 §8.5), so "is this rule followed?"
 * lands in the same list as "should this rule exist?".
 *
 * - not followed → `enforce`: prose is not doing the job; offer a hook rule.
 * - breaks late in long sessions → a `flag` pointing at context dilution.
 * - never triggered across a large enough window → a low-confidence `flag`:
 *   either the rule is obsolete or nothing exercised it yet.
 */

import { findingId } from "../engine/findings"
import type { Finding } from "../model"
import { showsDilution, verdictOf, type CheckResult } from "./backtest"
import type { RuleCheck } from "./checks"

/** Sessions scanned before "never triggered" means anything. */
export const UNTRIGGERED_MIN_SESSIONS = 10
/** Opportunities that make a low follow rate high-confidence. */
export const HIGH_CONFIDENCE_OPPORTUNITIES = 10

export function adherenceFindings(
  checks: readonly RuleCheck[],
  results: readonly CheckResult[]
): Finding[] {
  const byId = new Map(results.map((result) => [result.checkId, result]))
  const out: Finding[] = []
  for (const check of checks) {
    const result = byId.get(check.id)
    if (!result) continue
    const location = {
      surfaceKey: check.rule.surfaceKey,
      startLine: check.rule.startLine,
      endLine: check.rule.endLine,
    }
    const base = {
      group: "adherence" as const,
      location,
      evidence: check.rule.text,
      reason: "",
      sources: ["adherence" as const],
      checkId: check.id,
    }
    const verdict = verdictOf(check, result)
    if (verdict === "not-followed") {
      out.push({
        ...base,
        id: findingId(check.rule.surfaceKey, "unfollowed-rule", `${check.rule.text}|${check.id}`),
        pattern: "unfollowed-rule",
        confidence: result.opportunities >= HIGH_CONFIDENCE_OPPORTUNITIES ? "high" : "medium",
        action: "enforce",
      })
    }
    if (showsDilution(result)) {
      out.push({
        ...base,
        id: findingId(check.rule.surfaceKey, "diluted-rule", `${check.rule.text}|${check.id}`),
        pattern: "diluted-rule",
        confidence: "medium",
        action: "flag",
      })
    }
    if (verdict === "never-triggered" && result.sessionsScanned >= UNTRIGGERED_MIN_SESSIONS) {
      out.push({
        ...base,
        id: findingId(check.rule.surfaceKey, "untriggered-rule", `${check.rule.text}|${check.id}`),
        pattern: "untriggered-rule",
        confidence: "low",
        action: "flag",
      })
    }
  }
  return out
}
