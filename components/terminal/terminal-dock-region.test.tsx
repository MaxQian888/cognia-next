/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TerminalDockRegion } from "./terminal-dock-region"

jest.mock("@/components/terminal/terminal-dock", () => ({
  TerminalDock: () => <div data-testid="terminal-dock-stub" />,
}))

const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

// `motion.div` forwards unknown props to the DOM in the real library only after
// filtering; stub it so the animation props stay inspectable as data.
jest.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial,
      animate,
      exit,
      transition: _transition,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div
        {...(rest as Record<string, unknown>)}
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-exit={JSON.stringify(exit)}
      >
        {children as React.ReactNode}
      </div>
    ),
  },
}))

beforeEach(() => {
  useTerminalStore.getState().reset()
  flowMotion.reduce = false
  flowMotion.durationScale = 1
})

describe("TerminalDockRegion", () => {
  it("renders nothing while the dock is closed", () => {
    render(<TerminalDockRegion slot="bottom" />)
    expect(screen.queryByTestId("terminal-dock-region")).toBeNull()
  })

  it("renders only in the slot that matches the stored position", () => {
    useTerminalStore.getState().setPanelOpen(true)
    const { rerender } = render(<TerminalDockRegion slot="right" />)
    expect(screen.queryByTestId("terminal-dock-region")).toBeNull()

    rerender(<TerminalDockRegion slot="bottom" />)
    expect(screen.getByTestId("terminal-dock-region")).toHaveAttribute("data-position", "bottom")
  })

  it("sizes the bottom dock by height and slides it up from the bottom edge", () => {
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().setPanelSize(40)
    render(<TerminalDockRegion slot="bottom" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveStyle({ height: "40%" })
    expect(region.dataset.initial).toBe(JSON.stringify({ y: "100%" }))
    expect(region.className).toContain("shrink-0")
    expect(screen.getByTestId("terminal-dock-stub")).toBeInTheDocument()
  })

  it("sizes the right dock by width and slides it in from the right edge", () => {
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().setPanelSize(45)
    render(<TerminalDockRegion slot="right" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-position", "right")
    expect(region).toHaveStyle({ width: "45%" })
    expect(region.dataset.initial).toBe(JSON.stringify({ x: "100%" }))
  })

  it("maximizes the bottom dock by overlaying the page", () => {
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().toggleMaximized()
    render(<TerminalDockRegion slot="bottom" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-maximized", "true")
    expect(region.className).toContain("absolute inset-0")
    expect(region).toHaveStyle({ height: "100%" })
  })

  it("maximizes the right dock by width, never by absolute positioning", () => {
    // The shell row is not `relative`; making it so would re-parent every
    // absolute descendant of the rail and the routed page.
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().toggleMaximized()
    render(<TerminalDockRegion slot="right" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region).toHaveAttribute("data-maximized", "true")
    expect(region.className).not.toContain("absolute")
    expect(region).toHaveStyle({ width: "100%" })
  })

  it("drops the slide under reduced motion", () => {
    flowMotion.reduce = true
    useTerminalStore.getState().setPanelOpen(true)
    render(<TerminalDockRegion slot="bottom" />)
    const region = screen.getByTestId("terminal-dock-region")
    expect(region.dataset.initial).toBe(JSON.stringify(false))
    expect(region.dataset.exit).toBe(JSON.stringify({ y: 0, opacity: 0 }))
  })
})
