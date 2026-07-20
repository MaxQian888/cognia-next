import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { BrowserHistoryMenu } from "./browser-history-menu"

// The shared manual mock renders menu content inline so items are queryable
// without driving Radix open state (see components/ui/__mocks__/dropdown-menu).
jest.mock("@/components/ui/dropdown-menu")

const renderMenu = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

describe("BrowserHistoryMenu", () => {
  it("navigates to a clicked recent url with its full address", () => {
    const onNavigate = jest.fn()
    renderMenu(
      <BrowserHistoryMenu
        recent={["http://localhost:3000/about"]}
        onNavigate={onNavigate}
        onClear={jest.fn()}
      />
    )
    // Rows show a compact host+path label; the click carries the full URL.
    fireEvent.click(screen.getByText("localhost:3000/about"))
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:3000/about")
  })

  it("clears history from the footer item", () => {
    const onClear = jest.fn()
    renderMenu(
      <BrowserHistoryMenu
        recent={["http://localhost:3000/"]}
        onNavigate={jest.fn()}
        onClear={onClear}
      />
    )
    fireEvent.click(screen.getByText("Clear history"))
    expect(onClear).toHaveBeenCalled()
  })

  it("shows an empty state when there is no history", () => {
    renderMenu(<BrowserHistoryMenu recent={[]} onNavigate={jest.fn()} onClear={jest.fn()} />)
    expect(screen.getByText("No recent pages")).toBeInTheDocument()
  })

  it("falls back to the raw string for an unparseable url", () => {
    const onNavigate = jest.fn()
    renderMenu(
      <BrowserHistoryMenu recent={["not a url"]} onNavigate={onNavigate} onClear={jest.fn()} />
    )
    fireEvent.click(screen.getByText("not a url"))
    expect(onNavigate).toHaveBeenCalledWith("not a url")
  })
})
