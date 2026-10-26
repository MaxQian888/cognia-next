import type { RuleCheck } from "./checks"
import type { SessionEvents, ToolEvent } from "./events"
import {
  followRate,
  runBacktest,
  sampleKey,
  SAMPLES_PER_OUTCOME,
  showsDilution,
  verdictOf,
} from "./backtest"

const rule = { surfaceKey: "k", surfaceName: "CLAUDE.md", startLine: 1, endLine: 1, text: "r" }

function check(partial: Partial<RuleCheck>): RuleCheck {
  return {
    id: "C",
    kind: "forbid",
    trigger: { family: "shell", command: "^git push --force" },
    scope: "turn",
    summary: "s",
    rule,
    ...partial,
  }
}

let order = 0
function call(turn: number, partial: Partial<ToolEvent>): ToolEvent {
  return {
    sessionId: "s",
    messageId: "m",
    turn,
    order: order++,
    family: "shell",
    tool: "bash",
    paths: [],
    ...partial,
  }
}

function session(id: string, turns: number, events: ToolEvent[]): SessionEvents {
  return { sessionId: id, turns, events: events.map((event) => ({ ...event, sessionId: id })) }
}

const edit = (turn: number) => call(turn, { family: "edit", tool: "edit", paths: ["src/a.ts"] })
const test = (turn: number) => call(turn, { command: "pnpm test" })

describe("runBacktest", () => {
  it("counts every forbidden call as a violation", () => {
    const [result] = runBacktest({
      checks: [check({})],
      sessions: [
        session("a", 1, [
          call(0, { command: "git push --force" }),
          call(0, { command: "git status" }),
        ]),
        session("b", 1, [test(0)]),
      ],
    })
    expect(result).toMatchObject({
      sessionsScanned: 2,
      sessionsTriggered: 1,
      opportunities: 1,
      violated: 1,
      followed: 0,
    })
    expect(result!.samples[0]).toMatchObject({ outcome: "violated", call: "git push --force" })
  })

  it("requires the expectation after the trigger within the turn", () => {
    const after = check({
      kind: "require-after",
      trigger: { family: "edit" },
      expect: { family: "shell", command: "^pnpm test" },
    })
    const [result] = runBacktest({
      checks: [after],
      sessions: [session("a", 3, [edit(0), edit(0), test(0), edit(1), test(2)])],
    })
    expect(result).toMatchObject({ opportunities: 3, followed: 2, violated: 1 })
    const [sessionScoped] = runBacktest({
      checks: [{ ...after, scope: "session" }],
      sessions: [session("a", 3, [edit(0), edit(0), test(0), edit(1), test(2)])],
    })
    expect(sessionScoped).toMatchObject({ followed: 3, violated: 0 })
  })

  it("requires the expectation before the trigger", () => {
    const before = check({
      kind: "require-before",
      trigger: { family: "shell", command: "^git commit" },
      expect: { family: "shell", command: "^pnpm test" },
    })
    const commit = (turn: number) => call(turn, { command: "git commit -m x" })
    const [result] = runBacktest({
      checks: [before],
      sessions: [session("a", 2, [commit(0), test(1), commit(1)])],
    })
    expect(result).toMatchObject({ opportunities: 2, followed: 1, violated: 1 })
    expect(followRate(result!)).toBe(0.5)
  })

  it("excludes samples labeled false matches and caps samples per outcome", () => {
    const events = Array.from({ length: SAMPLES_PER_OUTCOME + 3 }, () =>
      call(0, { command: "git push --force" })
    )
    const labeled = sampleKey("C", "a", events[0]!.order)
    const [result] = runBacktest({
      checks: [check({})],
      sessions: [session("a", 1, events)],
      falseMatches: new Set([labeled]),
    })
    expect(result!.excluded).toBe(1)
    expect(result!.violated).toBe(SAMPLES_PER_OUTCOME + 2)
    expect(result!.samples).toHaveLength(SAMPLES_PER_OUTCOME)
  })

  it("reports a check that cannot run as invalid", () => {
    const [result] = runBacktest({
      checks: [check({ trigger: { family: "shell", command: "(a+)+" } })],
      sessions: [],
    })
    expect(result!.invalid).toBe(true)
    const [missing] = runBacktest({ checks: [check({ kind: "require-after" })], sessions: [] })
    expect(missing!.invalid).toBe(true)
  })

  it("measures early and late violation rates in long sessions", () => {
    const after = check({
      kind: "require-after",
      trigger: { family: "edit" },
      expect: { family: "shell", command: "^pnpm test" },
    })
    const events = [
      edit(0),
      test(0),
      edit(1),
      test(1),
      edit(2),
      test(2),
      edit(4),
      edit(5),
      edit(6),
      edit(7),
    ]
    const [result] = runBacktest({ checks: [after], sessions: [session("a", 8, events)] })
    expect(result!.dilution).toEqual({
      early: 0,
      late: 1,
      earlyOpportunities: 3,
      lateOpportunities: 4,
    })
    expect(showsDilution(result!)).toBe(true)
  })
})

describe("verdictOf", () => {
  const empty = {
    checkId: "C",
    sessionsScanned: 1,
    sessionsTriggered: 0,
    opportunities: 0,
    followed: 0,
    violated: 0,
    excluded: 0,
    samples: [],
  }

  it("judges each kind", () => {
    expect(verdictOf(check({}), { ...empty, invalid: true })).toBe("invalid")
    expect(verdictOf(check({}), empty)).toBe("never-triggered")
    expect(verdictOf(check({}), { ...empty, opportunities: 1, violated: 1 })).toBe("not-followed")
    const after = check({ kind: "require-after" })
    expect(verdictOf(after, { ...empty, opportunities: 2, followed: 0, violated: 2 })).toBe(
      "too-few"
    )
    expect(verdictOf(after, { ...empty, opportunities: 5, followed: 2, violated: 3 })).toBe(
      "not-followed"
    )
    expect(verdictOf(after, { ...empty, opportunities: 5, followed: 4, violated: 1 })).toBe(
      "followed"
    )
  })

  it("needs late data and a real gap for dilution", () => {
    const base = { ...empty, opportunities: 6 }
    expect(
      showsDilution({
        ...base,
        dilution: { early: 0.2, late: 0.25, earlyOpportunities: 3, lateOpportunities: 3 },
      })
    ).toBe(false)
    expect(
      showsDilution({
        ...base,
        dilution: { early: 0.2, late: 0.5, earlyOpportunities: 3, lateOpportunities: 3 },
      })
    ).toBe(true)
    expect(
      showsDilution({
        ...base,
        dilution: { early: 0, late: 1, earlyOpportunities: 3, lateOpportunities: 2 },
      })
    ).toBe(false)
    expect(
      showsDilution({
        ...base,
        dilution: { early: 0, late: 0, earlyOpportunities: 3, lateOpportunities: 3 },
      })
    ).toBe(false)
  })
})
