/**
 * @jest-environment jsdom
 */

// jsdom has no layout, so the real virtualizer renders zero rows.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 56,
        size: 56,
        end: (index + 1) * 56,
        lane: 0,
      })),
    getTotalSize: () => count * 56,
    measureElement: jest.fn(),
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

const loadAssetBytes = jest.fn(async () => null)
jest.mock("@/lib/skills/recording/controller", () => ({
  loadAssetBytes: (...a: unknown[]) => loadAssetBytes(...(a as [])),
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import { StageReview } from "./stage-review"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"
const WIDE = 900
const NARROW = 480

function step(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return { seq, tsMs: seq * 100, kind: "click", element: { name: `Button ${seq}` }, ...patch }
}

function store() {
  return useRecorderStore.getState()
}

/** Reach review with the given capture. */
function reachReview(steps: RecordedStep[], ignoredCount = 0) {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: 1,
    scope: { kind: "desktop" },
    limits: { maxDurationMs: 1, maxSteps: 1, maxBundleBytes: 1, maxGlobalBytes: 1 },
  })
  store().setCapturedSteps(steps)
  store().dispatch({ type: "STOP_REQUESTED" })
  store().dispatch({ type: "STOPPED", steps, ignoredCount, bundleId: RECORDING })
}

beforeEach(() => {
  jest.clearAllMocks()
  useRecorderStore.getState().reset()
})

describe("layout", () => {
  it("shows both panes with a keyboard-resizable split when wide enough", async () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)

    expect(screen.getByRole("listbox")).toBeInTheDocument()
    expect(screen.getByText("review.selectStep")).toBeInTheDocument()

    const separator = screen.getByRole("separator", { name: "review.splitAria" })
    expect(separator).toHaveAttribute("aria-valuenow", "42")
    separator.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(store().splitPercent).toBe(46)
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}")
    expect(store().splitPercent).toBe(38)
  })

  it("clamps the split rather than letting a pane vanish", async () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)
    const separator = screen.getByRole("separator", { name: "review.splitAria" })
    separator.focus()
    await userEvent.keyboard("{ArrowRight>10/}")
    expect(store().splitPercent).toBe(70)
    await userEvent.keyboard("{ArrowLeft>20/}")
    expect(store().splitPercent).toBe(25)
  })

  it("swaps panes instead of splitting when the Sheet is narrow", async () => {
    // The threshold is on the container: a wide window with a narrow Sheet is a
    // real configuration, so a viewport check would get it wrong.
    reachReview([step(1)])
    render(<StageReview containerWidth={NARROW} />)

    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    expect(screen.queryByText("review.selectStep")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("radio", { name: "review.viewDetail" }))
    expect(screen.getByText("review.selectStep")).toBeInTheDocument()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("reports how many steps survive review, and how many were out of scope", () => {
    reachReview([step(1), step(2)], 3)
    act(() => store().setEdits({ bySeq: { 2: { excluded: true } }, manual: [] }))
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.getByText(/review\.stepCount.*"included":1.*"total":2/)).toBeInTheDocument()
    expect(screen.getByText(/recording\.ignored.*"count":3/)).toBeInTheDocument()
  })

  it("explains an empty capture instead of showing an empty list", () => {
    reachReview([])
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.getByText("review.emptyTitle")).toBeInTheDocument()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })
})

describe("editing", () => {
  it("selecting a step opens the detail pane on narrow layouts", async () => {
    reachReview([step(1), step(2)])
    render(<StageReview containerWidth={NARROW} />)
    await userEvent.click(screen.getAllByRole("option")[1])
    expect(store().selectedStepSeq).toBe(2)
    expect(store().detailView).toBe("detail")
  })

  it("excluding a step is an edit, not a deletion", async () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)
    await userEvent.click(screen.getByRole("button", { name: "review.exclude" }))

    expect(store().edits.bySeq[1]).toMatchObject({ excluded: true })
    // The capture is untouched — that is what keeps a saved source immutable.
    expect(store().capturedSteps).toHaveLength(1)
  })

  it("restores an excluded step", async () => {
    reachReview([step(1)])
    act(() => store().setEdits({ bySeq: { 1: { excluded: true } }, manual: [] }))
    render(<StageReview containerWidth={WIDE} />)
    await userEvent.click(screen.getByRole("button", { name: "review.restore" }))
    expect(store().steps[0].excluded).toBe(false)
  })

  it("adds a manual step and clears the field", async () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)
    const input = screen.getByLabelText("review.manualTitle")
    expect(screen.getByRole("button", { name: /review\.manualSave/ })).toBeDisabled()

    await userEvent.type(input, "Log in first")
    await userEvent.click(screen.getByRole("button", { name: /review\.manualSave/ }))

    expect(store().edits.manual).toEqual([
      expect.objectContaining({ intent: "Log in first", seq: -1 }),
    ])
    expect(input).toHaveValue("")
  })

  it("reorders a selected step through the detail pane", async () => {
    reachReview([step(1), step(2)])
    act(() => store().setUi({ selectedStepSeq: 2 }))
    render(<StageReview containerWidth={WIDE} />)

    await userEvent.click(screen.getByRole("button", { name: "review.moveUp" }))
    // Order is an edit over the capture, like every other review decision.
    expect(store().steps.map((v) => v.seq)).toEqual([2, 1])
  })

  it("edits the intent and the verification note of a selected step", async () => {
    reachReview([step(1)])
    act(() => store().setUi({ selectedStepSeq: 1 }))
    render(<StageReview containerWidth={WIDE} />)

    await userEvent.type(screen.getByLabelText("review.intent"), "Go")
    expect(store().steps[0].intent).toBe("Go")

    await userEvent.type(screen.getByLabelText("review.verify"), "Done")
    expect(store().steps[0].verify).toBe("Done")
  })

  it("removes a manual step and clears the selection pointing at it", async () => {
    reachReview([step(1)])
    act(() => {
      store().setEdits({ bySeq: {}, manual: [{ seq: -1, afterSeq: 1, intent: "Log in" }] })
      store().setUi({ selectedStepSeq: -1 })
    })
    render(<StageReview containerWidth={WIDE} />)

    await userEvent.click(screen.getByRole("button", { name: "review.manualRemove" }))
    expect(store().edits.manual).toEqual([])
    // A selection pointing at a step that no longer exists would render an
    // empty detail pane with no way back.
    expect(store().selectedStepSeq).toBeNull()
  })

  it("opts a captured frame out of the saved skill", async () => {
    // A frame that exists is attached by default; the review pass is where the
    // user drops the ones that show something they would rather not ship.
    reachReview([step(1, { assetId: "asset-1" })])
    act(() => store().setUi({ selectedStepSeq: 1 }))
    render(<StageReview containerWidth={WIDE} />)

    expect(store().steps[0].screenshotSelected).toBe(true)
    expect(loadAssetBytes).toHaveBeenCalledWith("asset-1")

    await userEvent.click(screen.getByRole("checkbox"))
    expect(store().steps[0].screenshotSelected).toBe(false)
  })

  it("refuses a whitespace-only manual step", async () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)
    await userEvent.type(screen.getByLabelText("review.manualTitle"), "   ")
    expect(screen.getByRole("button", { name: /review\.manualSave/ })).toBeDisabled()
  })
})

describe("blockers", () => {
  it("names each problem with its step rather than counting them", () => {
    // "3 problems" makes the user hunt; naming each one is a checklist.
    reachReview([step(1, { element: undefined })])
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.getByText(/review\.blockers\.stepNeedsIntent.*"seq":1/)).toBeInTheDocument()
  })

  it("blocks on a capture with nothing included", () => {
    reachReview([step(1)])
    act(() => store().setEdits({ bySeq: { 1: { excluded: true } }, manual: [] }))
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.getByText(/review\.blockers\.noIncludedSteps/)).toBeInTheDocument()
  })

  it("blocks until every variable suggestion is answered", async () => {
    reachReview([
      step(1, {
        kind: "type",
        element: { name: "Order" },
        text: { kind: "text", value: "ORD-42" },
      }),
    ])
    // The controller derives these when the bundle lands; this test drives the
    // store directly, so it supplies them.
    act(
      () =>
        void store().dispatch({
          type: "SET_VARIABLES",
          variables: [
            { name: "order", kind: "variable", seq: 1, sample: "ORD-42", confirmed: false },
          ],
        })
    )
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.getByText(/review\.blockers\.unconfirmedVariable/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "confirm" }))
    expect(screen.queryByText(/review\.blockers\.unconfirmedVariable/)).not.toBeInTheDocument()
  })

  it("shows no alert when the review is clean", () => {
    reachReview([step(1)])
    render(<StageReview containerWidth={WIDE} />)
    expect(screen.queryByText(/review\.blockers\./)).not.toBeInTheDocument()
  })
})
