/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

import { SHELL_DOCK_DURATION_MS, SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TerminalDockRegion } from "./terminal-dock-region"

jest.mock("@/components/terminal/terminal-dock", () => ({
  TerminalDock: () => <div data-testid="terminal-dock-stub" />,
}))

const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

const mockBootReattach = jest.fn(async () => {})
jest.mock("@/lib/terminal/boot-reattach", () => ({
  bootReattachTerminals: () => mockBootReattach(),
}))

/**
 * The region resolves its stored percentage against the measured parent, so a
 * jsdom parent (every rect is 0) has to be given one for the pixel assertions.
 * Without it the component falls back to the raw percentage, which is the
 * pre-measurement path the last two cases cover on purpose.
 */
function measureParents(sizePx: number) {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return { width: sizePx, height: sizePx } as DOMRect
    },
  })
}

function unmeasureParents() {
  Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect")
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  flowMotion.reduce = false
  flowMotion.durationScale = 1
  mockBootReattach.mockClear()
  unmeasureParents()
})

afterEach(() => {
  unmeasureParents()
  jest.useRealTimers()
})

function open(position: "bottom" | "right" = "bottom") {
  act(() => {
    useTerminalStore.getState().setPanelPosition(position)
    useTerminalStore.getState().setPanelOpen(true)
  })
}

describe("TerminalDockRegion", () => {
  it("stays mounted at zero size while the dock is closed", () => {
    // A CSS transition needs the element on both sides of the change, so the
    // region is never unmounted — it collapses, and takes itself out of the
    // accessibility tree while it is shut.
    render(<TerminalDockRegion slot="bottom" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-open", "false")
    expect(region).toHaveStyle({ height: "0px" })
    expect(region).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByTestId("terminal-dock-stub")).toBeNull()
  })

  it("only opens in the slot that matches the stored position", () => {
    render(
      <>
        <TerminalDockRegion slot="bottom" />
        <TerminalDockRegion slot="right" />
      </>
    )
    open("bottom")
    const [bottom, right] = screen.getAllByTestId("terminal-dock-region")
    expect(bottom).toHaveAttribute("data-position", "bottom")
    expect(bottom).toHaveAttribute("data-open", "true")
    expect(right).toHaveAttribute("data-open", "false")
    expect(screen.getAllByTestId("terminal-dock-stub")).toHaveLength(1)
  })

  it("animates the space it occupies, not a transform, when opening", () => {
    measureParents(1000)
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => useTerminalStore.getState().setPanelSize(40))
    const region = screen.getByTestId("terminal-dock-region")
    // 40% of the measured 1000px parent, in px — so the inner surface can hold
    // still while the outer box animates.
    expect(region).toHaveStyle({ height: "400px" })
    expect(region.className).toContain("transition-[width,height]")
    expect(region.className).toContain(SHELL_DOCK_TIMING_CLASS)
  })

  it("holds the dock surface at its final size for the whole animation", () => {
    // `TerminalInstance` re-fits xterm and resizes the PTY from a
    // ResizeObserver; a surface that tweened with the outer box would spend the
    // animation sending SIGWINCH to the child process.
    measureParents(1000)
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => useTerminalStore.getState().setPanelSize(40))
    expect(screen.getByTestId("terminal-dock-surface")).toHaveStyle({ height: "400px" })

    act(() => useTerminalStore.getState().setPanelOpen(false))
    // Collapsing moves the outer box only; the surface still measures 400px.
    expect(screen.getByTestId("terminal-dock-region")).toHaveStyle({ height: "0px" })
    expect(screen.getByTestId("terminal-dock-surface")).toHaveStyle({ height: "400px" })
  })

  it("collapses on the same transition it expanded on", () => {
    measureParents(1000)
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    const openingClass = screen.getByTestId("terminal-dock-region").className

    act(() => useTerminalStore.getState().setPanelOpen(false))
    const region = screen.getByTestId("terminal-dock-region")
    expect(region.className).toContain("transition-[width,height]")
    expect(region.className).toContain(SHELL_DOCK_TIMING_CLASS)
    expect(openingClass).toContain(SHELL_DOCK_TIMING_CLASS)
    expect(region).toHaveStyle({ height: "0px" })
  })

  it("keeps the dock mounted for exactly one collapse animation", () => {
    jest.useFakeTimers()
    measureParents(1000)
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => useTerminalStore.getState().setPanelOpen(false))
    // Still there, sliding out with its content.
    expect(screen.getByTestId("terminal-dock-stub")).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    // xterm, its PTY attachment and the dock's subscriptions must not stay live
    // behind a zero-size box.
    expect(screen.queryByTestId("terminal-dock-stub")).toBeNull()
    expect(screen.getByTestId("terminal-dock-region").className).not.toContain(
      "transition-[width,height]"
    )
  })

  it("leaves the transition off while the separator is dragged", () => {
    jest.useFakeTimers()
    measureParents(1000)
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    // A drag mutates the same `height`; a standing transition would rubber-band
    // it against the pointer.
    act(() => useTerminalStore.getState().setPanelSize(50))
    const region = screen.getByTestId("terminal-dock-region")
    expect(region.className).not.toContain("transition-[width,height]")
    expect(region).toHaveStyle({ height: "500px" })
  })

  it("sizes the right dock along the other axis", () => {
    measureParents(1200)
    render(<TerminalDockRegion slot="right" />)
    open("right")
    act(() => useTerminalStore.getState().setPanelSize(45))
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-position", "right")
    expect(region).toHaveStyle({ width: "540px" })
    expect(screen.getByTestId("terminal-dock-surface")).toHaveStyle({ width: "540px" })
  })

  it("hands the dock between slots without animating the departing edge", () => {
    // Two live <TerminalDock/> trees mean two xterm attachments for the same
    // session, so the edge losing the dock drops it in the same commit.
    measureParents(1000)
    render(
      <>
        <TerminalDockRegion slot="bottom" />
        <TerminalDockRegion slot="right" />
      </>
    )
    open("bottom")
    act(() => useTerminalStore.getState().setPanelPosition("right"))
    const [bottom, right] = screen.getAllByTestId("terminal-dock-region")
    expect(bottom.className).not.toContain("transition-[width,height]")
    expect(bottom).toHaveStyle({ height: "0px" })
    expect(right).toHaveAttribute("data-open", "true")
    expect(screen.getAllByTestId("terminal-dock-stub")).toHaveLength(1)
  })

  it("maximizes the bottom dock by overlaying the page", () => {
    // Squeezing the chat to zero height instead would re-lay-out its whole
    // scroller and lose the read position.
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => useTerminalStore.getState().toggleMaximized())
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-maximized", "true")
    expect(region.className).toContain("absolute inset-x-0 bottom-0")
    expect(region.className).toContain("z-40")
    expect(region).toHaveStyle({ height: "100%" })
  })

  it("maximizes the right dock by width, never by absolute positioning", () => {
    // The shell row is not `relative`; making it so would re-parent every
    // absolute descendant of the rail and the routed page.
    render(<TerminalDockRegion slot="right" />)
    open("right")
    act(() => useTerminalStore.getState().toggleMaximized())
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-maximized", "true")
    expect(region.className).not.toContain("absolute")
    expect(region).toHaveStyle({ width: "100%" })
  })

  it("falls back to the stored percentage before the parent is measured", () => {
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    act(() => useTerminalStore.getState().setPanelSize(40))
    expect(screen.getByTestId("terminal-dock-region")).toHaveStyle({ height: "40%" })
    expect(screen.getByTestId("terminal-dock-surface")).toHaveStyle({ height: "40%" })
  })

  it("drops the transition entirely under reduced motion", () => {
    flowMotion.reduce = true
    render(<TerminalDockRegion slot="bottom" />)
    open("bottom")
    const region = screen.getByTestId("terminal-dock-region")
    expect(region.className).not.toContain("transition-[width,height]")

    act(() => useTerminalStore.getState().setPanelOpen(false))
    // Nothing to slide out with, so the dock goes immediately.
    expect(screen.queryByTestId("terminal-dock-stub")).toBeNull()
  })
})

/**
 * The region, not the dock, is where reattaching belongs: it is mounted
 * permanently by the shell while `<TerminalDock/>` only exists while the panel
 * is open — and the tab count a remote host kept across the reload has to be
 * back before the status-bar chip reads it (the chip hides itself at zero).
 */
describe("reattaching at boot", () => {
  it("asks for the host's surviving sessions on mount, panel closed included", () => {
    useTerminalStore.setState({ panelOpen: false } as never)
    render(<TerminalDockRegion slot="bottom" />)
    expect(mockBootReattach).toHaveBeenCalledTimes(1)
  })

  it("still asks when the panel is open", () => {
    useTerminalStore.setState({ panelOpen: true, panelPosition: "bottom" } as never)
    render(<TerminalDockRegion slot="bottom" />)
    expect(mockBootReattach).toHaveBeenCalledTimes(1)
  })
})
