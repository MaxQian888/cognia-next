/**
 * @jest-environment jsdom
 */
import { createRef } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"

// The repo's manual popover mock renders its content inline, so a test can read
// what a tier packed away without driving Radix's portal.
jest.mock("@/components/ui/popover")
let mockWidth = 0
jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => mockWidth }))

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  BrowserToolbar,
  COMPACT_TOOLBAR_PX,
  WIDE_TOOLBAR_PX,
  addressDisplayParts,
  toolbarTier,
} from "./browser-toolbar"

const toolbarRef = createRef<HTMLDivElement>()

const renderToolbar = (props: Partial<Parameters<typeof BrowserToolbar>[0]> = {}) =>
  render(
    <TooltipProvider>
      <BrowserToolbar
        toolbarRef={toolbarRef}
        navigation={<button type="button">nav</button>}
        inspectActions={<button type="button">inspect</button>}
        pageActions={<button type="button">page</button>}
        overflowExtras={<span>extras</span>}
        url=""
        onUrlChange={jest.fn()}
        onSubmit={jest.fn()}
        {...props}
      />
    </TooltipProvider>
  )

beforeEach(() => {
  mockWidth = 0
})

// The pane is docked in the chat right rail as often as it fills the /browser
// page, and that rail's floor is well under what the full control row needs.
describe("toolbarTier", () => {
  it("takes the widest branch before the first measurement", () => {
    expect(toolbarTier(0)).toBe("wide")
  })

  it("packs down as the measured width shrinks", () => {
    expect(toolbarTier(WIDE_TOOLBAR_PX)).toBe("wide")
    expect(toolbarTier(WIDE_TOOLBAR_PX - 1)).toBe("medium")
    expect(toolbarTier(COMPACT_TOOLBAR_PX)).toBe("medium")
    expect(toolbarTier(COMPACT_TOOLBAR_PX - 1)).toBe("compact")
  })
})

describe("BrowserToolbar packing", () => {
  it("keeps every control inline when wide", () => {
    mockWidth = 800
    renderToolbar()
    const bar = screen.getByTestId("browser-toolbar")
    expect(bar).toHaveAttribute("data-tier", "wide")
    expect(within(bar).getByText("inspect")).toBeInTheDocument()
    expect(within(bar).getByText("page")).toBeInTheDocument()
  })

  it("collapses page setup first at medium width", () => {
    mockWidth = 500
    renderToolbar()
    const bar = screen.getByTestId("browser-toolbar")
    expect(bar).toHaveAttribute("data-tier", "medium")
    fireEvent.click(screen.getByTestId("browser-toolbar-more"))
    const popover = screen.getByTestId("popover-content")
    expect(within(popover).getByText("page")).toBeInTheDocument()
    expect(within(popover).queryByText("inspect")).toBeNull()
  })

  it("collapses everything at compact width, so nothing becomes unreachable", () => {
    mockWidth = 300
    renderToolbar()
    expect(screen.getByTestId("browser-toolbar")).toHaveAttribute("data-tier", "compact")
    fireEvent.click(screen.getByTestId("browser-toolbar-more"))
    const popover = screen.getByTestId("popover-content")
    expect(within(popover).getByText("inspect")).toBeInTheDocument()
    expect(within(popover).getByText("page")).toBeInTheDocument()
    expect(within(popover).getByText("extras")).toBeInTheDocument()
  })

  it("marks the trigger when a collapsed control is off its default", () => {
    mockWidth = 300
    const { rerender } = renderToolbar()
    expect(screen.queryByTestId("browser-toolbar-more-active")).toBeNull()
    rerender(
      <TooltipProvider>
        <BrowserToolbar
          toolbarRef={toolbarRef}
          navigation={<button type="button">nav</button>}
          inspectActions={<button type="button">inspect</button>}
          url=""
          onUrlChange={jest.fn()}
          onSubmit={jest.fn()}
          collapsedActive
        />
      </TooltipProvider>
    )
    expect(screen.getByTestId("browser-toolbar-more-active")).toBeInTheDocument()
  })
})

describe("BrowserToolbar address bar", () => {
  it("paints the pretty form over the field without rewriting its value", () => {
    renderToolbar({
      url: "https://www.example.com/docs",
      addressDisplay: addressDisplayParts("https://www.example.com/docs"),
    })
    // Copying still yields the real URL.
    expect(screen.getByLabelText("http://localhost:3000")).toHaveValue(
      "https://www.example.com/docs"
    )
    expect(screen.getByTestId("browser-url-display")).toHaveTextContent("example.com/docs")
  })

  it("shows a half-typed draft verbatim", () => {
    renderToolbar({ url: "exa", addressDisplay: null })
    expect(screen.queryByTestId("browser-url-display")).toBeNull()
  })

  it("draws the progress bar only while loading", () => {
    const { rerender } = renderToolbar()
    expect(screen.queryByTestId("browser-progress")).toBeNull()
    rerender(
      <TooltipProvider>
        <BrowserToolbar
          toolbarRef={toolbarRef}
          navigation={<button type="button">nav</button>}
          url=""
          onUrlChange={jest.fn()}
          onSubmit={jest.fn()}
          loading
        />
      </TooltipProvider>
    )
    expect(screen.getByTestId("browser-progress")).toBeInTheDocument()
  })
})

describe("addressDisplayParts", () => {
  it("drops the scheme, a leading www. and a bare trailing slash", () => {
    expect(addressDisplayParts("https://www.example.com/")).toEqual({
      host: "example.com",
      rest: "",
      secure: true,
    })
  })

  it("keeps the path, query and hash so they can be dimmed", () => {
    expect(addressDisplayParts("http://localhost:3000/a?b=c#d")).toEqual({
      host: "localhost:3000",
      rest: "/a?b=c#d",
      secure: false,
    })
  })

  it("declines anything that is not a parseable http(s) address", () => {
    expect(addressDisplayParts("exa")).toBeNull()
    expect(addressDisplayParts("file:///tmp/x")).toBeNull()
    expect(addressDisplayParts("")).toBeNull()
  })
})
