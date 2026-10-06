import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RichBlockFullscreen } from "./rich-block-fullscreen"

const mockMobile = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockMobile.current }))

afterEach(() => {
  mockMobile.current = false
})

function renderFullscreen(onOpenChange = jest.fn()) {
  render(
    <TooltipProvider>
      <RichBlockFullscreen
        open
        onOpenChange={onOpenChange}
        title="Table"
        subtitle="12 rows"
        testId="table-fullscreen"
        actions={<button type="button">csv</button>}
      >
        <p>content</p>
      </RichBlockFullscreen>
    </TooltipProvider>
  )
  return onOpenChange
}

describe("RichBlockFullscreen", () => {
  it("opens as a dialog on desktop with its header, actions and body", () => {
    const onOpenChange = renderFullscreen()
    expect(screen.getByTestId("table-fullscreen")).toHaveAttribute("data-variant", "dialog")
    expect(screen.getByTestId("table-fullscreen-header")).toHaveTextContent("Table")
    expect(screen.getByTestId("table-fullscreen-header")).toHaveTextContent("12 rows")
    expect(screen.getByRole("button", { name: "csv" })).toBeInTheDocument()
    expect(screen.getByTestId("table-fullscreen-body")).toHaveTextContent("content")
    fireEvent.click(screen.getByTestId("table-fullscreen-close"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("opens as a sheet on mobile", () => {
    mockMobile.current = true
    renderFullscreen()
    expect(screen.getByTestId("table-fullscreen")).toHaveAttribute("data-variant", "sheet")
    expect(screen.getByRole("button", { name: "Close fullscreen view" })).toBeInTheDocument()
  })
})
