import type { CheckResult } from "./backtest"
import type { RuleCheck } from "./checks"
import {
  adherenceFindings,
  HIGH_CONFIDENCE_OPPORTUNITIES,
  UNTRIGGERED_MIN_SESSIONS,
} from "./findings"

const check: RuleCheck = {
  id: "C",
  kind: "require-after",
  trigger: { family: "edit" },
  expect: { family: "shell", command: "^pnpm test" },
  scope: "turn",
  summary: "s",
  rule: {
    surfaceKey: "k",
    surfaceName: "CLAUDE.md",
    startLine: 3,
    endLine: 4,
    text: "Run tests after edits.",
  },
}

function result(partial: Partial<CheckResult>): CheckResult {
  return {
    checkId: "C",
    sessionsScanned: 5,
    sessionsTriggered: 3,
    opportunities: 5,
    followed: 1,
    violated: 4,
    excluded: 0,
    samples: [],
    ...partial,
  }
}

describe("adherenceFindings", () => {
  it("offers enforcement for a rule that is not followed", () => {
    const [finding] = adherenceFindings([check], [result({})])
    expect(finding).toMatchObject({
      group: "adherence",
      pattern: "unfollowed-rule",
      action: "enforce",
      confidence: "medium",
      checkId: "C",
      location: { surfaceKey: "k", startLine: 3, endLine: 4 },
      evidence: "Run tests after edits.",
    })
    expect(
      adherenceFindings(
        [check],
        [result({ opportunities: HIGH_CONFIDENCE_OPPORTUNITIES, followed: 1, violated: 9 })]
      )[0]!.confidence
    ).toBe("high")
  })

  it("flags dilution and rules that never applied", () => {
    const diluted = adherenceFindings(
      [check],
      [
        result({
          followed: 4,
          violated: 1,
          dilution: { early: 0, late: 0.6, earlyOpportunities: 3, lateOpportunities: 3 },
        }),
      ]
    )
    expect(diluted.map((finding) => finding.pattern)).toEqual(["diluted-rule"])
    const untriggered = adherenceFindings(
      [check],
      [
        result({
          opportunities: 0,
          followed: 0,
          violated: 0,
          sessionsScanned: UNTRIGGERED_MIN_SESSIONS,
        }),
      ]
    )
    expect(untriggered).toEqual([
      expect.objectContaining({ pattern: "untriggered-rule", confidence: "low", action: "flag" }),
    ])
    expect(
      adherenceFindings(
        [check],
        [result({ opportunities: 0, followed: 0, violated: 0, sessionsScanned: 2 })]
      )
    ).toEqual([])
  })

  it("ignores checks without a result and followed rules", () => {
    expect(adherenceFindings([check], [])).toEqual([])
    expect(adherenceFindings([check], [result({ followed: 5, violated: 0 })])).toEqual([])
  })
})
