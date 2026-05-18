import { fireEvent, render, screen } from "@testing-library/react"
import { OcrCapabilitiesTab } from "./ocr-capabilities-tab"

// next-intl is globally mocked in jest.setup.ts — keys fall back to the
// literal dotted string when no entry exists yet, so we assert on test-ids
// here instead of on visible text. End-to-end visibility is covered by the
// integration test in ocr-section.test.tsx after the i18n keys are added.

describe("OcrCapabilitiesTab", () => {
  it("renders the matrix wrapper for a known provider", () => {
    render(<OcrCapabilitiesTab providerId="mathpix" />)
    expect(screen.getByTestId("ocr-capabilities-tab")).toBeInTheDocument()
  })

  it("renders 11 capability rows (8 value + multilang + maxPages + costTier)", () => {
    render(<OcrCapabilitiesTab providerId="mathpix" />)
    const valueCells = [
      ...screen.queryAllByTestId("ocr-cap-yes"),
      ...screen.queryAllByTestId("ocr-cap-no"),
      ...screen.queryAllByTestId("ocr-cap-partial"),
    ]
    expect(valueCells.length).toBe(8)
    // Count rows: 2 count cells (or one count + one unlimited) + 1 cost cell.
    const countOrUnlimited =
      screen.queryAllByTestId("ocr-cap-count").length +
      screen.queryAllByTestId("ocr-cap-unlimited").length
    expect(countOrUnlimited).toBe(2)
    expect(screen.queryAllByTestId("ocr-cap-cost").length).toBe(1)
  })

  it("renders the math row as yes for mathpix", () => {
    render(<OcrCapabilitiesTab providerId="mathpix" />)
    expect(screen.queryAllByTestId("ocr-cap-yes").length).toBeGreaterThan(0)
  })

  it("renders unlimited icon for local engines with no per-call cap", () => {
    render(<OcrCapabilitiesTab providerId="tesseract-wasm" />)
    expect(screen.queryAllByTestId("ocr-cap-unlimited").length).toBeGreaterThan(0)
  })

  it("renders an empty state for unknown providers", () => {
    render(<OcrCapabilitiesTab providerId="does-not-exist" />)
    expect(screen.getByTestId("ocr-capabilities-empty")).toBeInTheDocument()
  })

  it("fires onCompareClick when the compare CTA is pressed", () => {
    const onCompareClick = jest.fn()
    render(<OcrCapabilitiesTab providerId="mistral-ocr" onCompareClick={onCompareClick} />)
    fireEvent.click(screen.getByTestId("ocr-capabilities-compare-cta"))
    expect(onCompareClick).toHaveBeenCalledTimes(1)
  })

  it("hides the compare CTA when no handler is provided", () => {
    render(<OcrCapabilitiesTab providerId="mistral-ocr" />)
    expect(screen.queryByTestId("ocr-capabilities-compare-cta")).not.toBeInTheDocument()
  })
})
