/**
 * @jest-environment jsdom
 */

import { useEffect } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import {
  PEEK_SHADOW_ROOM_PX,
  SidebarPeekEdge,
  SidebarPeekFrame,
  SIDEBAR_PEEK_STRIP_PX,
} from "./sidebar-peek-panel"

describe("SidebarPeekEdge", () => {
  it("sits on the named edge and stays out of the accessibility tree", () => {
    render(
      <SidebarPeekEdge
        side="left"
        active={false}
        onMouseEnter={jest.fn()}
        onMouseLeave={jest.fn()}
      />
    )
    const edge = screen.getByTestId("sidebar-peek-edge")
    expect(edge).toHaveAttribute("aria-hidden", "true")
    expect(edge).toHaveAttribute("data-side", "left")
    expect(edge).toHaveClass("left-0")
    expect(edge).toHaveStyle({ width: `${SIDEBAR_PEEK_STRIP_PX}px` })
  })

  it("mirrors to the other seam for a right-docked rail", () => {
    render(
      <SidebarPeekEdge
        side="right"
        active={false}
        onMouseEnter={jest.fn()}
        onMouseLeave={jest.fn()}
      />
    )
    expect(screen.getByTestId("sidebar-peek-edge")).toHaveClass("right-0")
  })

  it("shows the grip on hover, and holds it lit while the panel is out", () => {
    const { rerender } = render(
      <SidebarPeekEdge
        side="left"
        active={false}
        onMouseEnter={jest.fn()}
        onMouseLeave={jest.fn()}
      />
    )
    // At rest it is invisible until the pointer reaches the strip: a permanent
    // bar on the seam reads as a border that failed to collapse.
    expect(screen.getByTestId("sidebar-peek-grip")).toHaveClass("opacity-0")
    expect(screen.getByTestId("sidebar-peek-grip")).toHaveClass("group-hover:opacity-100")
    rerender(
      <SidebarPeekEdge side="left" active onMouseEnter={jest.fn()} onMouseLeave={jest.fn()} />
    )
    // Out, it stays lit rather than needing a hover it can no longer receive:
    // the open panel covers the strip, so `group-hover` can never fire.
    expect(screen.getByTestId("sidebar-peek-grip")).toHaveClass("opacity-100")
    expect(screen.getByTestId("sidebar-peek-grip")).not.toHaveClass("group-hover:opacity-100")
  })

  it("reports both halves of the hover intent", () => {
    const onMouseEnter = jest.fn()
    const onMouseLeave = jest.fn()
    render(
      <SidebarPeekEdge
        side="left"
        active={false}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
    )
    const edge = screen.getByTestId("sidebar-peek-edge")
    fireEvent.mouseEnter(edge)
    fireEvent.mouseLeave(edge)
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
    expect(onMouseLeave).toHaveBeenCalledTimes(1)
  })
})

const frameProps = {
  side: "left" as const,
  width: 260,
  onPin: jest.fn(),
  onMouseEnter: jest.fn(),
  onMouseLeave: jest.fn(),
}

describe("SidebarPeekFrame", () => {
  it("unarmed, is the rail's fixed-width inner layer and nothing else", () => {
    render(
      <SidebarPeekFrame {...frameProps} armed={false} open={false}>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    expect(screen.queryByTestId("sidebar-peek-panel")).toBeNull()
    expect(screen.queryByTestId("sidebar-peek-pin")).toBeNull()
    expect(screen.getByTestId("list")).toBeInTheDocument()
  })

  it("clips the parked panel, so it never lands on the icon column beside it", () => {
    const { container } = render(
      <SidebarPeekFrame {...frameProps} armed open={false}>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    const panel = screen.getByTestId("sidebar-peek-panel")
    const clip = panel.parentElement
    expect(clip).toHaveClass("overflow-hidden")
    // Wider than the panel it holds, so the elevation survives the clip.
    expect(clip).toHaveStyle({ width: `${260 + PEEK_SHADOW_ROOM_PX}px` })
    // And it lets every pointer through to the conversation underneath.
    expect(clip).toHaveClass("pointer-events-none")
    expect(panel).toHaveClass("pointer-events-auto")
    expect(container.firstChild).toBe(clip)
  })

  it("armed and parked, holds the same list off screen and out of reach", () => {
    render(
      <SidebarPeekFrame {...frameProps} armed open={false}>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    const panel = screen.getByTestId("sidebar-peek-panel")
    expect(panel).toContainElement(screen.getByTestId("list"))
    expect(panel).not.toHaveAttribute("data-open")
    expect(panel).toHaveAttribute("inert")
    expect(panel).toHaveStyle({ transform: "translateX(calc(-100% - 24px))", width: "260px" })
  })

  it("open, slides onto the seam and becomes reachable", () => {
    render(
      <SidebarPeekFrame {...frameProps} armed open>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    const panel = screen.getByTestId("sidebar-peek-panel")
    expect(panel).toHaveAttribute("data-open", "true")
    expect(panel).not.toHaveAttribute("inert")
    expect(panel).toHaveStyle({ transform: "translateX(0)" })
  })

  it("parks past the other seam for a right-docked rail", () => {
    render(
      <SidebarPeekFrame {...frameProps} side="right" armed open={false}>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    const panel = screen.getByTestId("sidebar-peek-panel")
    expect(panel).toHaveStyle({ transform: "translateX(calc(100% + 24px))" })
    expect(panel).toHaveClass("right-0")
  })

  it("offers the way back to a pinned rail from inside the flyout", () => {
    const onPin = jest.fn()
    render(
      <SidebarPeekFrame {...frameProps} onPin={onPin} armed open>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    fireEvent.click(screen.getByTestId("sidebar-peek-pin"))
    expect(onPin).toHaveBeenCalledTimes(1)
  })

  it("keeps the same list mounted across arm and disarm", () => {
    // The whole conversation list is this component's child. Arming a peek
    // moves it by class, so a collapse must not cost the query the user typed,
    // the scroll offset, or a re-subscribe of every live query inside it.
    let mounts = 0
    function List() {
      useEffect(() => {
        mounts += 1
      }, [])
      return <div data-testid="list" />
    }
    const { rerender } = render(
      <SidebarPeekFrame {...frameProps} armed={false} open={false}>
        <List />
      </SidebarPeekFrame>
    )
    expect(mounts).toBe(1)

    rerender(
      <SidebarPeekFrame {...frameProps} armed open={false}>
        <List />
      </SidebarPeekFrame>
    )
    expect(screen.getByTestId("sidebar-peek-panel")).toContainElement(screen.getByTestId("list"))
    rerender(
      <SidebarPeekFrame {...frameProps} armed={false} open={false}>
        <List />
      </SidebarPeekFrame>
    )
    expect(screen.getByTestId("list")).toBeInTheDocument()
    expect(mounts).toBe(1)
  })

  it("carries no surface attribute in flow, so no wallpaper blur rides along", () => {
    // `globals.css` hangs the backdrop blur off a bare `[data-surface-layer]`.
    const { container } = render(
      <SidebarPeekFrame {...frameProps} armed={false} open={false}>
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    expect(container.querySelector("[data-surface-layer]")).toBeNull()
    expect(container.querySelector("[data-elevation]")).toBeNull()
  })

  it("holds the peek open while the pointer is on the panel", () => {
    const onMouseEnter = jest.fn()
    const onMouseLeave = jest.fn()
    render(
      <SidebarPeekFrame
        {...frameProps}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        armed
        open
      >
        <div data-testid="list" />
      </SidebarPeekFrame>
    )
    const panel = screen.getByTestId("sidebar-peek-panel")
    fireEvent.mouseEnter(panel)
    fireEvent.mouseLeave(panel)
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
    expect(onMouseLeave).toHaveBeenCalledTimes(1)
  })
})
