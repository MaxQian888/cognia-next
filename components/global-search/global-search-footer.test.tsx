/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { GlobalSearchFooter } from "./global-search-footer"

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
  it("shows the keyboard hints and the syntax help trigger", () => {
    renderFooter()
    expect(screen.getByText("footer.navigate")).toBeInTheDocument()
    expect(screen.getByText("footer.open")).toBeInTheDocument()
    const help = screen.getByRole("button", { name: "footer.syntax" })
    expect(help).toBeInTheDocument()
    // Pressing the help button must not steal focus from the input.
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
    fireEvent(help, pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
    expect(screen.queryByTestId("global-search-result-count")).toBeNull()
    expect(screen.queryByTestId("global-search-coverage")).toBeNull()
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
