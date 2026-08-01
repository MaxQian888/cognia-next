import {
  applyStepEdits,
  EMPTY_STEP_EDITS,
  excludeStep,
  includedSteps,
  insertManualStep,
  nextManualSeq,
  removeManualStep,
  reorderSteps,
  restoreStep,
  reviewBlockers,
  selectedScreenshotIds,
  setStepEdit,
  type StepEdits,
} from "./step-model"
import type { RecordedStep } from "./types"

function step(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return {
    seq,
    tsMs: seq * 10,
    kind: "click",
    element: { name: `Button ${seq}` },
    ...patch,
  }
}

const CAPTURED = [step(1), step(2), step(3)]

describe("applyStepEdits", () => {
  it("returns capture order with no edits", () => {
    const views = applyStepEdits(CAPTURED)
    expect(views.map((v) => v.seq)).toEqual([1, 2, 3])
    expect(views.every((v) => !v.excluded && !v.manual)).toBe(true)
  })

  it("drops out-of-scope markers — there is nothing there to review", () => {
    const views = applyStepEdits([step(1), step(2, { kind: "outOfScope", element: undefined })])
    expect(views.map((v) => v.seq)).toEqual([1])
  })

  it("selects a screenshot by default only when the step has one", () => {
    const views = applyStepEdits([step(1, { assetId: "a" }), step(2)])
    expect(views[0].screenshotSelected).toBe(true)
    expect(views[1].screenshotSelected).toBe(false)
  })

  it("flags a step with nothing describable as needing an intent", () => {
    const views = applyStepEdits([step(1, { element: undefined })])
    expect(views[0].needsIntent).toBe(true)
  })

  it("clears that flag once the user writes one", () => {
    const edits = setStepEdit(EMPTY_STEP_EDITS, 1, { intent: "Open the report" })
    const views = applyStepEdits([step(1, { element: undefined })], edits)
    expect(views[0].needsIntent).toBe(false)
    expect(views[0].intent).toBe("Open the report")
  })
})

describe("exclude and restore", () => {
  it("keeps an excluded step in the list rather than deleting it", () => {
    const views = applyStepEdits(CAPTURED, excludeStep(EMPTY_STEP_EDITS, 2))
    expect(views.map((v) => v.seq)).toEqual([1, 2, 3])
    expect(views[1].excluded).toBe(true)
    expect(includedSteps(views).map((v) => v.seq)).toEqual([1, 3])
  })

  it("preserves the intent and verify text through an exclude/restore round trip", () => {
    let edits = setStepEdit(EMPTY_STEP_EDITS, 2, {
      intent: "Open the invoice",
      verify: "It is on screen",
    })
    edits = excludeStep(edits, 2)
    edits = restoreStep(edits, 2)
    const view = applyStepEdits(CAPTURED, edits)[1]
    expect(view.excluded).toBe(false)
    expect(view.intent).toBe("Open the invoice")
    expect(view.verify).toBe("It is on screen")
  })
})

describe("manual steps", () => {
  it("counts down from -1 so it can never collide with a native seq", () => {
    expect(nextManualSeq(EMPTY_STEP_EDITS)).toBe(-1)
    const once = insertManualStep(EMPTY_STEP_EDITS, 1, "a")
    expect(nextManualSeq(once)).toBe(-2)
  })

  it("inserts immediately after its anchor", () => {
    const edits = insertManualStep(EMPTY_STEP_EDITS, 2, "Wait for the export")
    const views = applyStepEdits(CAPTURED, edits)
    expect(views.map((v) => v.seq)).toEqual([1, 2, -1, 3])
    expect(views[2].manual).toBe(true)
    expect(views[2].intent).toBe("Wait for the export")
  })

  it("appends when the anchor is gone", () => {
    const edits = insertManualStep(EMPTY_STEP_EDITS, 99, "Orphan")
    expect(applyStepEdits(CAPTURED, edits).at(-1)?.seq).toBe(-1)
  })

  it("flags an empty manual step as needing an intent", () => {
    const edits = insertManualStep(EMPTY_STEP_EDITS, 1, "   ")
    expect(applyStepEdits(CAPTURED, edits)[1].needsIntent).toBe(true)
  })

  it("removes a manual step and its edits together", () => {
    let edits = insertManualStep(EMPTY_STEP_EDITS, 1, "temp")
    edits = setStepEdit(edits, -1, { verify: "x" })
    edits = removeManualStep(edits, -1)
    expect(edits.manual).toHaveLength(0)
    expect(edits.bySeq[-1]).toBeUndefined()
  })
})

describe("reordering", () => {
  it("moves a step and records an explicit order", () => {
    const views = applyStepEdits(CAPTURED)
    const edits = reorderSteps(views, EMPTY_STEP_EDITS, 3, -1)
    expect(applyStepEdits(CAPTURED, edits).map((v) => v.seq)).toEqual([1, 3, 2])
  })

  it("clamps at the ends instead of wrapping", () => {
    const views = applyStepEdits(CAPTURED)
    expect(reorderSteps(views, EMPTY_STEP_EDITS, 1, -1)).toBe(EMPTY_STEP_EDITS)
    expect(reorderSteps(views, EMPTY_STEP_EDITS, 3, 1)).toBe(EMPTY_STEP_EDITS)
  })

  it("ignores an unknown seq", () => {
    const views = applyStepEdits(CAPTURED)
    expect(reorderSteps(views, EMPTY_STEP_EDITS, 99, 1)).toBe(EMPTY_STEP_EDITS)
  })

  it("still shows a step a stale order forgot", () => {
    // Losing work because an order list went out of date would be the worst
    // possible failure of an ordering feature.
    const edits: StepEdits = { bySeq: {}, manual: [], order: [3, 1] }
    expect(applyStepEdits(CAPTURED, edits).map((v) => v.seq)).toEqual([3, 1, 2])
  })
})

describe("selectedScreenshotIds", () => {
  it("returns only included steps whose frame is selected", () => {
    const captured = [step(1, { assetId: "a" }), step(2, { assetId: "b" }), step(3)]
    const edits = excludeStep(EMPTY_STEP_EDITS, 2)
    expect(selectedScreenshotIds(applyStepEdits(captured, edits))).toEqual(["a"])
  })

  it("honours a manual deselection", () => {
    const captured = [step(1, { assetId: "a" })]
    const edits = setStepEdit(EMPTY_STEP_EDITS, 1, { screenshotSelected: false })
    expect(selectedScreenshotIds(applyStepEdits(captured, edits))).toEqual([])
  })
})

describe("reviewBlockers", () => {
  it("blocks when nothing is included", () => {
    let edits = EMPTY_STEP_EDITS
    for (const s of CAPTURED) edits = excludeStep(edits, s.seq)
    const blockers = reviewBlockers(applyStepEdits(CAPTURED, edits), [])
    expect(blockers).toContainEqual({ code: "noIncludedSteps" })
  })

  it("names each step that needs a description", () => {
    const views = applyStepEdits([step(1, { element: undefined }), step(2)])
    expect(reviewBlockers(views, [])).toContainEqual({ code: "stepNeedsIntent", seq: 1 })
  })

  it("ignores an excluded step that would otherwise need one", () => {
    const edits = excludeStep(EMPTY_STEP_EDITS, 1)
    const views = applyStepEdits([step(1, { element: undefined }), step(2)], edits)
    expect(reviewBlockers(views, [])).toEqual([])
  })

  it("blocks on an unconfirmed input", () => {
    const views = applyStepEdits(CAPTURED)
    expect(
      reviewBlockers(views, [{ name: "term", confirmed: false, kind: "variable" }])
    ).toContainEqual({ code: "unconfirmedVariable", name: "term" })
  })

  it("blocks when something marked secret still holds a value", () => {
    const views = applyStepEdits(CAPTURED)
    expect(
      reviewBlockers(views, [
        { name: "password", confirmed: true, kind: "sensitive", sample: "hunter2" },
      ])
    ).toContainEqual({ code: "sensitiveVariableHasValue", name: "password" })
  })

  it("passes a clean timeline", () => {
    const views = applyStepEdits(CAPTURED)
    expect(reviewBlockers(views, [{ name: "term", confirmed: true, kind: "variable" }])).toEqual([])
  })
})
