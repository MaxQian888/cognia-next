/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

import { GradingEditor, previewExtraction } from "./grading-editor"
import type { GradingSpec } from "@/types/eval/grading"
import { GSM8K_ANSWER_PATTERN } from "@/types/eval/grading"

describe("previewExtraction", () => {
  it("shows what a numeric rule pulls out of a marked golden answer", () => {
    expect(
      previewExtraction({ mode: "numeric", pattern: GSM8K_ANSWER_PATTERN }, "…\n#### 18")
    ).toBe("18")
  })

  it("shows what a choice rule pulls out", () => {
    expect(previewExtraction({ mode: "choice" }, "B")).toBe("B")
  })

  it("returns null when the rule matches nothing — the case would be ungraded", () => {
    expect(previewExtraction({ mode: "numeric", pattern: GSM8K_ANSWER_PATTERN }, "42")).toBeNull()
  })

  it("has nothing to preview for the text modes, or for empty text", () => {
    expect(previewExtraction({ mode: "exact" }, "anything")).toBeNull()
    expect(previewExtraction({ mode: "numeric" }, "")).toBeNull()
  })
})

describe("GradingEditor", () => {
  const setup = (value: GradingSpec, sampleExpected?: string) => {
    const onChange = jest.fn()
    render(
      <GradingEditor
        value={value}
        onChange={onChange}
        {...(sampleExpected ? { sampleExpected } : {})}
      />
    )
    return onChange
  }

  it("switches mode", () => {
    const onChange = setup({ mode: "exact" })
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "numeric" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "numeric" })
  })

  it("shows pattern + tolerance only for numeric", () => {
    const { unmount } = render(<GradingEditor value={{ mode: "exact" }} onChange={jest.fn()} />)
    expect(screen.queryByLabelText("tolerance")).not.toBeInTheDocument()
    unmount()
    setup({ mode: "numeric" })
    expect(screen.getByLabelText("pattern")).toBeInTheDocument()
    expect(screen.getByLabelText("tolerance")).toBeInTheDocument()
  })

  it("edits the numeric pattern and tolerance", () => {
    const onChange = setup({ mode: "numeric" })
    fireEvent.change(screen.getByLabelText("pattern"), { target: { value: "#### (\\d+)" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "numeric", pattern: "#### (\\d+)" })
    fireEvent.change(screen.getByLabelText("tolerance"), { target: { value: "0.5" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "numeric", tolerance: 0.5 })
  })

  it("clears the pattern back to undefined when emptied", () => {
    const onChange = setup({ mode: "regex", pattern: "^yes" })
    fireEvent.change(screen.getByLabelText("pattern"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "regex", pattern: undefined })
  })

  it("uppercases the choice alphabet", () => {
    const onChange = setup({ mode: "choice" })
    fireEvent.change(screen.getByLabelText("alphabet"), { target: { value: "abcd" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "choice", alphabet: "ABCD" })
  })

  it("offers normalization toggles for the text modes only", () => {
    const { unmount } = render(<GradingEditor value={{ mode: "numeric" }} onChange={jest.fn()} />)
    expect(screen.queryByText("normalize.stripArticles")).not.toBeInTheDocument()
    unmount()
    const onChange = setup({ mode: "exact" })
    fireEvent.click(screen.getByText("normalize.stripArticles"))
    expect(onChange).toHaveBeenCalledWith({
      mode: "exact",
      normalize: { stripArticles: true },
    })
  })

  it("edits the regex pattern", () => {
    const onChange = setup({ mode: "regex" })
    fireEvent.change(screen.getByLabelText("pattern"), { target: { value: "^yes\\b" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "regex", pattern: "^yes\\b" })
  })

  it("clears the choice alphabet back to undefined when emptied", () => {
    const onChange = setup({ mode: "choice", alphabet: "ABCD" })
    fireEvent.change(screen.getByLabelText("alphabet"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "choice", alphabet: undefined })
  })

  it("falls back to 0 on a non-numeric tolerance", () => {
    const onChange = setup({ mode: "numeric", tolerance: 5 })
    fireEvent.change(screen.getByLabelText("tolerance"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith({ mode: "numeric", tolerance: 0 })
  })

  it("toggles the remaining normalization options and can turn case-folding off", () => {
    const onChange = setup({ mode: "contains-any" })
    fireEvent.click(screen.getByText("normalize.caseInsensitive"))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "contains-any",
      normalize: { caseInsensitive: false },
    })
    fireEvent.click(screen.getByText("normalize.stripPunctuation"))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "contains-any",
      normalize: { stripPunctuation: true },
    })
  })

  it("preserves existing normalization when toggling one option", () => {
    const onChange = setup({ mode: "exact", normalize: { stripPunctuation: true } })
    fireEvent.click(screen.getByText("normalize.stripArticles"))
    expect(onChange).toHaveBeenCalledWith({
      mode: "exact",
      normalize: { stripPunctuation: true, stripArticles: true },
    })
  })

  it("warns when the rule would extract nothing from a real sample answer", () => {
    // The failure this preview exists to prevent: a wrong pattern does not
    // error, it silently leaves every case ungraded.
    setup({ mode: "numeric", pattern: GSM8K_ANSWER_PATTERN }, "42 with no marker")
    expect(screen.getByTestId("grading-extraction")).toHaveTextContent("extractNothing")
  })

  it("shows the extracted value when the rule works", () => {
    setup({ mode: "numeric", pattern: GSM8K_ANSWER_PATTERN }, "reasoning…\n#### 18")
    expect(screen.getByTestId("grading-extraction")).toHaveTextContent('{"value":"18"}')
  })

  it("shows no extraction preview without a sample or for text modes", () => {
    const { unmount } = render(<GradingEditor value={{ mode: "numeric" }} onChange={jest.fn()} />)
    expect(screen.queryByTestId("grading-extraction")).not.toBeInTheDocument()
    unmount()
    setup({ mode: "exact" }, "Paris")
    expect(screen.queryByTestId("grading-extraction")).not.toBeInTheDocument()
  })
})
