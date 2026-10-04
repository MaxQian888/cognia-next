/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { GlobalSearchFooter } from "./global-search-footer"

let mockShowKeyboardHints = true
jest.mock("@/hooks/ui/use-pointer", () => ({
  useShowKeyboardHints: () => mockShowKeyboardHints,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const renderFooter = (props: Partial<React.ComponentProps<typeof GlobalSearchFooter>> = {}) =>
  render(
    <TooltipProvider>
      <GlobalSearchFooter
        totalHits={null}
        tookMs={null}
        coverage="complete"
        loading={false}
        {...props}
      />
    </TooltipProvider>
  )

describe("GlobalSearchFooter", () => {
  it("shows the keyboard hints and no syntax help (that lives in the input row)", () => {
    renderFooter()
    expect(screen.getByText("footer.navigate")).toBeInTheDocument()
    expect(screen.getByText("footer.open")).toBeInTheDocument()
    expect(screen.queryByTestId("global-search-syntax-help")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByTestId("global-search-result-count")).toBeNull()
    expect(screen.queryByTestId("global-search-coverage")).toBeNull()
  })

  it("draws no key legend on a device without a keyboard", () => {
    mockShowKeyboardHints = false
    try {
      renderFooter({ totalHits: 2 })
      expect(screen.queryByTestId("global-search-key-legend")).toBeNull()
      expect(screen.queryByText("footer.navigate")).toBeNull()
      expect(screen.queryByText("footer.open")).toBeNull()
      expect(screen.getByTestId("global-search-result-count")).toBeInTheDocument()
    } finally {
      mockShowKeyboardHints = true
    }
  })

  it("renders nothing in compact mode without a coverage warning", () => {
    const { container } = renderFooter({ compact: true, totalHits: 4, tookMs: 2, loading: false })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("global-search-footer")).toBeNull()
  })

  it("renders nothing in compact mode while loading", () => {
    const { container } = renderFooter({ compact: true, coverage: "partial", loading: true })
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps only the coverage warning in compact mode", () => {
    renderFooter({ compact: true, totalHits: 4, tookMs: 2, coverage: "indexing" })
    expect(screen.getByTestId("global-search-coverage")).toHaveTextContent(
      "footer.coverageIndexing"
    )
    expect(screen.queryByTestId("global-search-key-legend")).toBeNull()
    expect(screen.queryByTestId("global-search-result-count")).toBeNull()
    expect(screen.queryByText(/footer.took/)).toBeNull()
  })

  it("shows count, timing and coverage notes", () => {
    const { rerender } = renderFooter({ totalHits: 4, tookMs: 12, coverage: "indexing" })
    expect(screen.getByTestId("global-search-result-count")).toHaveTextContent(
      'footer.results:{"count":4}'
    )
    expect(screen.getByText('footer.took:{"ms":12}')).toBeInTheDocument()
    expect(screen.getByTestId("global-search-coverage")).toHaveTextContent(
      "footer.coverageIndexing"
    )
    rerender(
      <TooltipProvider>
        <GlobalSearchFooter totalHits={4} tookMs={null} coverage="partial" loading={false} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("global-search-coverage")).toHaveTextContent("footer.coveragePartial")
    expect(screen.queryByText(/footer.took/)).toBeNull()
  })

  it("shows the loading label instead of counts while loading", () => {
    renderFooter({ totalHits: 4, tookMs: 1, coverage: "partial", loading: true })
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByTestId("global-search-result-count")).toBeNull()
    expect(screen.queryByTestId("global-search-coverage")).toBeNull()
  })
})
