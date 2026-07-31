import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"
import { buildCalibrationSeed, judgeScorerIds } from "./seed-from-run"

const JUDGE = "judge-task-completion"

function row(over: Partial<EvalRunCaseRow> = {}): EvalRunCaseRow {
  return {
    id: `r1::${over.caseId ?? "c1"}`,
    runId: "r1",
    caseId: "c1",
    scores: {
      [JUDGE]: { value: 1, passed: true, status: "scored", reasoning: "covers every field" },
    },
    verdict: "pass",
    passAt1: true,
    output: "the agent's answer",
    ...over,
  }
}

const base = {
  setId: "set-1",
  criterion: "task completion",
  rubric: "Pass only if the answer fully accomplishes the request.",
  scorerId: JUDGE,
  inputsByCase: { c1: "the user's question", c2: "another question" },
}

describe("buildCalibrationSeed", () => {
  it("turns a judged case into a calibration item pre-labelled with the judge's verdict", () => {
    // Sets used to have to be typed by hand, so nobody built one and no judge's
    // agreement was ever measured.
    const { items, skipped } = buildCalibrationSeed({ ...base, rows: [row()] })
    expect(skipped).toEqual([])
    expect(items).toEqual([
      {
        setId: "set-1",
        criterion: "task completion",
        rubric: base.rubric,
        input: "the user's question",
        output: "the agent's answer",
        goldLabel: "pass",
        source: "eval-case",
        sourceCaseId: "c1",
        notes: "covers every field",
      },
    ])
  })

  it("carries a failing verdict across as a failing starting label", () => {
    const { items } = buildCalibrationSeed({
      ...base,
      rows: [row({ scores: { [JUDGE]: { value: 0, passed: false, status: "scored" } } })],
    })
    expect(items[0].goldLabel).toBe("fail")
    expect(items[0]).not.toHaveProperty("notes")
  })

  it("attaches the case's golden answer when it has one", () => {
    const { items } = buildCalibrationSeed({
      ...base,
      rows: [row()],
      referencesByCase: { c1: "42" },
    })
    expect(items[0].reference).toBe("42")
  })

  it("skips a case the judge never graded, naming the reason", () => {
    const { items, skipped } = buildCalibrationSeed({
      ...base,
      rows: [
        row({ caseId: "c1", scores: {} }),
        row({
          caseId: "c2",
          scores: { [JUDGE]: { value: 0, passed: false, status: "not-applicable" } },
        }),
      ],
    })
    expect(items).toEqual([])
    expect(skipped).toEqual([
      { caseId: "c1", reason: "scorer did not run on this case" },
      { caseId: "c2", reason: "verdict was not-applicable" },
    ])
  })

  it("skips a case whose answer was not kept", () => {
    // Output storage can be disabled; an item with no answer is unlabelable.
    const noOutput = row()
    delete noOutput.output
    const { items, skipped } = buildCalibrationSeed({ ...base, rows: [noOutput] })
    expect(items).toEqual([])
    expect(skipped).toEqual([{ caseId: "c1", reason: "run kept no answer for this case" }])
  })

  it("skips a case that has since been deleted from the dataset", () => {
    const { items, skipped } = buildCalibrationSeed({
      ...base,
      rows: [row({ caseId: "gone" })],
      inputsByCase: {},
    })
    expect(items).toEqual([])
    expect(skipped).toEqual([{ caseId: "gone", reason: "case no longer exists" }])
  })

  it("treats a legacy row with no status as a real verdict", () => {
    const legacy = row({ scores: { [JUDGE]: { value: 1, passed: true } } })
    expect(buildCalibrationSeed({ ...base, rows: [legacy] }).items).toHaveLength(1)
  })
})

describe("judgeScorerIds", () => {
  it("lists the scorers that produced a verdict, sorted", () => {
    const rows = [
      row({
        scores: {
          [JUDGE]: { value: 1, passed: true, status: "scored" },
          assertion: { value: 0, passed: false, status: "not-applicable" },
        },
      }),
      row({ caseId: "c2", scores: { cost: { value: 1, passed: false, status: "measurement" } } }),
    ]
    expect(judgeScorerIds(rows)).toEqual([JUDGE])
  })

  it("returns nothing for a run where no scorer graded anything", () => {
    expect(judgeScorerIds([row({ scores: {} })])).toEqual([])
  })
})
