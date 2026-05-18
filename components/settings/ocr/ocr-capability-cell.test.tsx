import { render, screen } from "@testing-library/react"
import {
  OcrCapabilityCostCell,
  OcrCapabilityCountCell,
  OcrCapabilityValueCell,
} from "./ocr-capability-cell"

// next-intl is globally mocked in jest.setup.ts — keys without an entry in
// en.json fall back to the literal dotted string. The aria-labels reference
// `ocr.capabilities.values.*`; we only assert on data-testid here.

describe("OcrCapabilityValueCell", () => {
  it("renders a check for yes", () => {
    render(<OcrCapabilityValueCell value="yes" />)
    expect(screen.getByTestId("ocr-cap-yes")).toBeInTheDocument()
  })

  it("renders a circle-dot for partial", () => {
    render(<OcrCapabilityValueCell value="partial" />)
    expect(screen.getByTestId("ocr-cap-partial")).toBeInTheDocument()
  })

  it("renders an X for no", () => {
    render(<OcrCapabilityValueCell value="no" />)
    expect(screen.getByTestId("ocr-cap-no")).toBeInTheDocument()
  })
})

describe("OcrCapabilityCostCell", () => {
  it("renders a free label for the free tier", () => {
    render(<OcrCapabilityCostCell tier="free" />)
    expect(screen.getByTestId("ocr-cap-cost")).toBeInTheDocument()
  })

  it("renders dollar signs for paid tiers", () => {
    const { rerender } = render(<OcrCapabilityCostCell tier="$" />)
    expect(screen.getByTestId("ocr-cap-cost")).toHaveTextContent("$")
    rerender(<OcrCapabilityCostCell tier="$$$" />)
    expect(screen.getByTestId("ocr-cap-cost")).toHaveTextContent("$$$")
  })
})

describe("OcrCapabilityCountCell", () => {
  it("renders the number when finite", () => {
    render(<OcrCapabilityCountCell value={42} />)
    expect(screen.getByTestId("ocr-cap-count")).toHaveTextContent("42")
  })

  it("renders the infinity icon for null", () => {
    render(<OcrCapabilityCountCell value={null} />)
    expect(screen.getByTestId("ocr-cap-unlimited")).toBeInTheDocument()
  })
})
