/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

import { ALL_SCORER_IDS } from "@cognia/eval-core/scorers/catalog"
import { ScorerPicker, expandScorerSelection, normalizeScorerSelection } from "./scorer-picker"

describe("scorer selection helpers", () => {
  it("expands the empty sentinel to every id and passes an explicit list through", () => {
    expect(expandScorerSelection([])).toEqual([...ALL_SCORER_IDS])
    expect(expandScorerSelection(["cost"])).toEqual(["cost"])
  })

  it("normalizes a full selection back to the empty sentinel", () => {
    expect(normalizeScorerSelection([...ALL_SCORER_IDS])).toEqual([])
  })

  it("normalizes a partial selection in catalog order, ignoring unknown ids", () => {
    expect(normalizeScorerSelection(["cost", "zzz", "tool-selection"])).toEqual([
      "tool-selection",
      "cost",
    ])
  })
})

describe("ScorerPicker", () => {
  it("renders every catalog scorer checked when fully selected", () => {
    render(<ScorerPicker value={[...ALL_SCORER_IDS]} onChange={jest.fn()} />)
    expect(screen.getByLabelText("scorerCatalog.cost")).toBeChecked()
  })

  it("toggles a single scorer off", () => {
    const onChange = jest.fn()
    render(<ScorerPicker value={[...ALL_SCORER_IDS]} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("scorerCatalog.cost"))
    const next = onChange.mock.calls[0][0] as string[]
    expect(next).not.toContain("cost")
    expect(next).toContain("tool-selection")
  })

  it("group select-all adds every scorer in the dimension", () => {
    const onChange = jest.fn()
    // Start with nothing selected; the tool-use group's toggle should add all 5.
    render(<ScorerPicker value={[]} onChange={onChange} />)
    // Two "scorerPicker.all" buttons exist (one per group with none selected);
    // click the first (tool-use, first catalog dimension).
    fireEvent.click(screen.getAllByText("scorerPicker.all")[0])
    const next = onChange.mock.calls[0][0] as string[]
    expect(next).toEqual(
      expect.arrayContaining([
        "tool-selection",
        "tool-args",
        "tool-order",
        "tool-redundancy",
        "trajectory-unordered",
      ])
    )
  })

  it("disables the LLM scorers when no judge is available", () => {
    render(<ScorerPicker value={[...ALL_SCORER_IDS]} onChange={jest.fn()} judgeAvailable={false} />)
    expect(screen.getByLabelText("scorerCatalog.judge-task-completion")).toBeDisabled()
    expect(screen.getByLabelText("scorerCatalog.tool-selection")).not.toBeDisabled()
  })
})
