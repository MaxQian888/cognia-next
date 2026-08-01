/**
 * @jest-environment jsdom
 */

/** The options the component hands the virtualizer, captured for assertion. */
let virtualizerOptions: {
  count: number
  estimateSize: () => number
  getScrollElement: () => Element | null
  overscan: number
} | null = null

// jsdom has no layout, so the real virtualizer renders zero rows. Render every
// item instead — the row assertions below stay meaningful.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    ...(() => {
      virtualizerOptions = options as never
      return {}
    })(),
    ...(({ count }: { count: number }) => ({
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
    }))(options),
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { RecordedStepView } from "@/lib/skills/recording/step-model"

import { describeStepRow, ReviewTimeline, type StepTranslator } from "./review-timeline"

const t = ((key: string) => key) as unknown as StepTranslator

function view(patch: Partial<RecordedStepView> = {}): RecordedStepView {
  return {
    seq: 1,
    captured: { seq: 1, tsMs: 0, kind: "click", element: { name: "Export" } },
    manual: false,
    excluded: false,
    intent: null,
    verify: null,
    screenshotSelected: false,
    needsIntent: false,
    ...patch,
  }
}

function renderTimeline(steps: RecordedStepView[], selectedSeq: number | null = null) {
  const onSelect = jest.fn()
  const onToggleExclude = jest.fn()
  render(
    <ReviewTimeline
      steps={steps}
      selectedSeq={selectedSeq}
      onSelect={onSelect}
      onToggleExclude={onToggleExclude}
    />
  )
  return { onSelect, onToggleExclude }
}

describe("virtualizer configuration", () => {
  it("is fixed-height and points at the scroll container", () => {
    // Fixed-height rows are why this list needs no `measureElement`, and so no
    // ResizeObserver per row while steps are still streaming in.
    renderTimeline([view()])
    expect(virtualizerOptions).toMatchObject({ count: 1, overscan: 8 })
    expect(virtualizerOptions!.estimateSize()).toBe(56)
    expect(virtualizerOptions!.getScrollElement()).toBe(
      screen.getByRole("listbox", { name: "review.timelineAria" })
    )
  })
})

describe("describeStepRow", () => {
  it("prefers the user's intent over anything derived", () => {
    expect(describeStepRow(view({ intent: "Open the export dialog" }), t)).toBe(
      "Open the export dialog"
    )
  })

  it("names the element the user acted on", () => {
    expect(describeStepRow(view(), t)).toBe("Export")
  })

  it("falls back to the automation id, then to OCR", () => {
    expect(
      describeStepRow(
        view({
          captured: { seq: 1, tsMs: 0, kind: "click", element: { automationId: "btnSave" } },
        }),
        t
      )
    ).toBe("btnSave")
    expect(
      describeStepRow(view({ captured: { seq: 1, tsMs: 0, kind: "click", ocrHint: "Submit" } }), t)
    ).toBe("Submit")
  })

  it("shows typed text, but never a secret", () => {
    expect(
      describeStepRow(
        view({
          captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "text", value: "hello" } },
        }),
        t
      )
    ).toBe("hello")
    // The placeholder describes the *fact* of a secret; there is nothing to show.
    expect(
      describeStepRow(
        view({ captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "sensitive" } } }),
        t
      )
    ).toBe("review.sensitive")
  })

  it("renders a chord structurally", () => {
    expect(
      describeStepRow(
        view({
          captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "keys", chord: "cmd+c" } },
        }),
        t
      )
    ).toBe("cmd+c")
  })

  it("names a manual step as one", () => {
    expect(describeStepRow(view({ manual: true, captured: null }), t)).toBe("stepKind.manual")
  })

  it("falls back to the step kind when nothing was learned", () => {
    expect(describeStepRow(view({ captured: { seq: 1, tsMs: 0, kind: "scroll" } }), t)).toBe(
      "stepKind.scroll"
    )
  })
})

describe("ReviewTimeline", () => {
  it("renders one option per step, numbered from 1", () => {
    renderTimeline([
      view({ seq: 1 }),
      view({ seq: 2, captured: { seq: 2, tsMs: 1, kind: "click", element: { name: "Save" } } }),
    ])
    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent("Export")
    expect(options[1]).toHaveTextContent("Save")
  })

  it("marks the selected step for assistive technology", () => {
    renderTimeline([view({ seq: 1 }), view({ seq: 2 })], 2)
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true")
    expect(selected).toHaveLength(1)
  })

  it("selects on click and on Enter or Space", async () => {
    const { onSelect } = renderTimeline([view({ seq: 7 })])
    await userEvent.click(screen.getByRole("option"))
    expect(onSelect).toHaveBeenCalledWith(7)

    screen.getByRole("option").focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard(" ")
    expect(onSelect).toHaveBeenCalledTimes(3)
  })

  it("keeps an excluded step in the list so it can be restored", () => {
    // Removing it would make the timeline stop matching what the user did, and
    // "restore" would have nothing to point at.
    renderTimeline([view({ seq: 1, excluded: true })])
    expect(screen.getByRole("option")).toHaveTextContent("review.excluded")
    expect(screen.getByRole("button", { name: "review.restore" })).toBeInTheDocument()
  })

  it("toggles exclusion without also selecting the row", async () => {
    const { onSelect, onToggleExclude } = renderTimeline([view({ seq: 3 })])
    await userEvent.click(screen.getByRole("button", { name: "review.exclude" }))
    expect(onToggleExclude).toHaveBeenCalledWith(3, true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("restores an excluded step", async () => {
    const { onToggleExclude } = renderTimeline([view({ seq: 3, excluded: true })])
    await userEvent.click(screen.getByRole("button", { name: "review.restore" }))
    expect(onToggleExclude).toHaveBeenCalledWith(3, false)
  })

  it("flags a step the model could not be told anything about", () => {
    renderTimeline([view({ needsIntent: true })])
    expect(screen.getByRole("option")).toHaveTextContent("review.needsIntent")
  })

  it("marks a manual step and a selected screenshot", () => {
    renderTimeline([view({ manual: true, captured: null, screenshotSelected: false })])
    expect(screen.getByRole("option")).toHaveTextContent("review.manualBadge")

    render(
      <ReviewTimeline
        steps={[view({ seq: 9, screenshotSelected: true })]}
        selectedSeq={null}
        onSelect={jest.fn()}
        onToggleExclude={jest.fn()}
      />
    )
    expect(screen.getAllByLabelText("review.screenshotSelect").length).toBeGreaterThan(0)
  })

  it("names the list for assistive technology", () => {
    renderTimeline([view()])
    expect(screen.getByRole("listbox", { name: "review.timelineAria" })).toBeInTheDocument()
  })

  it("renders an empty list without crashing", () => {
    renderTimeline([])
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })
})
