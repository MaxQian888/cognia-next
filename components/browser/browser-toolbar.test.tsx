/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs"
import path from "node:path"
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
  it.each([300, 500, 680, 800])("reserves the address row for navigation at %ipx", (width) => {
    mockWidth = width
    renderToolbar({ trailing: <button type="button">take control</button> })
    const addressRow = screen.getByTestId("browser-navigation-row")
    expect(within(addressRow).getByRole("textbox")).toBeInTheDocument()
    expect(within(addressRow).getByRole("button", { name: "nav" })).toBeInTheDocument()
    expect(within(addressRow).queryByRole("button", { name: "take control" })).toBeNull()
    expect(within(addressRow).queryByText("inspect")).toBeNull()
    expect(within(addressRow).queryByText("page")).toBeNull()
    expect(
      within(screen.getByTestId("browser-tools-row")).getByText("take control")
    ).toBeInTheDocument()
  })

  it("does not offer an empty overflow menu when all actions are visible", () => {
    mockWidth = 800
    renderToolbar({ overflowExtras: undefined })
    expect(screen.queryByTestId("browser-toolbar-more")).toBeNull()
  })

  it("omits the tools row for navigation-only surfaces", () => {
    renderToolbar({ inspectActions: undefined, pageActions: undefined, overflowExtras: undefined })
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(screen.queryByTestId("browser-tools-row")).toBeNull()
  })

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

  it("preserves the address draft and every action when the panel is resized", () => {
    const props = {
      navigation: <button type="button">nav</button>,
      inspectActions: <button type="button">inspect</button>,
      pageActions: <button type="button">page</button>,
      url: "https://example.com/unfinished-draft",
      onUrlChange: jest.fn(),
      onSubmit: jest.fn(),
    }
    const { rerender } = renderToolbar(props)
    for (const width of [280, 460, 680, 320]) {
      mockWidth = width
      rerender(
        <TooltipProvider>
          <BrowserToolbar {...props} toolbarRef={toolbarRef} />
        </TooltipProvider>
      )
      expect(screen.getByRole("textbox")).toHaveValue(props.url)
      expect(screen.getAllByRole("button", { name: "inspect" })).toHaveLength(1)
      expect(screen.getAllByRole("button", { name: "page" })).toHaveLength(1)
    }
  })
})

describe("BrowserToolbar address bar", () => {
  it("keeps editing and submitting the address independent of tool actions", () => {
    const onUrlChange = jest.fn()
    const onSubmit = jest.fn((event) => event.preventDefault())
    renderToolbar({ onUrlChange, onSubmit })
    const field = screen.getByRole("textbox")
    fireEvent.change(field, { target: { value: "https://example.com/docs" } })
    expect(onUrlChange).toHaveBeenCalledWith("https://example.com/docs")
    fireEvent.submit(field.closest("form")!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

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

  // Focusing selects the whole address, and a selection under a transparent
  // input is painted by the browser regardless — straight over the overlay.
  it("drops the overlay while the field has focus", () => {
    renderToolbar({
      url: "https://www.example.com/docs",
      addressDisplay: addressDisplayParts("https://www.example.com/docs"),
    })
    const field = screen.getByLabelText("http://localhost:3000")
    fireEvent.focus(field)
    expect(screen.queryByTestId("browser-url-display")).toBeNull()
    expect(field).not.toHaveClass("text-transparent")
    fireEvent.blur(field)
    expect(screen.getByTestId("browser-url-display")).toBeInTheDocument()
    expect(field).toHaveClass("text-transparent")
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

// The bar is status, not decoration. Under the blunt reduce-motion guard it ran
// one 1ms sweep and froze as a third-width stub at the left edge; it has to be
// exempted the way the policy in globals.css exempts other status motion — on
// every one of its three guard paths.
describe("progress bar under reduced motion", () => {
  const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8")

  it.each([
    "html.reduce-motion .browser-progress-bar",
    'html[data-reduce-motion="true"] .browser-progress-bar',
    'html:not([data-motion-respect="off"]) .browser-progress-bar',
  ])("keeps signalling under %s", (selector) => {
    const start = css.indexOf(selector)
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf("}", start))
    expect(block).toContain("animation-name: motion-safe-fade-pulse")
    expect(block).toContain("animation-iteration-count: infinite")
    expect(block).toContain("width: 100%")
  })
})
