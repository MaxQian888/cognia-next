/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TerminalDockRegion } from "./terminal-dock-region"
import {
  TerminalDockSurfaceProvider,
  resolveActiveSurface,
  type TerminalDockSurfaceClaim,
} from "./terminal-dock-surface"

// A stand-in for the real dock that counts mounts and live effects — what a
// remount costs is xterm being disposed and rebuilt.
const mockDockMounts = jest.fn()
let mockDockEffects = 0
jest.mock("@/components/terminal/terminal-dock", () => ({
  TerminalDock: ({ resizeBasisPx }: { resizeBasisPx?: number }) => {
    const { useEffect, useState } = jest.requireActual<typeof import("react")>("react")
    useState(() => mockDockMounts())
    useEffect(() => {
      mockDockEffects += 1
      return () => {
        mockDockEffects -= 1
      }
    }, [])
    return <div data-testid="terminal-dock-stub" data-resize-basis={resizeBasisPx} />
  },
}))

const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

jest.mock("@/lib/terminal/boot-reattach", () => ({
  bootReattachTerminals: async () => {},
}))

function renderShell() {
  return render(
    <TerminalDockSurfaceProvider>
      <div data-testid="column">
        <TerminalDockRegion slot="bottom" />
      </div>
      <TerminalDockRegion slot="right" />
    </TerminalDockSurfaceProvider>
  )
}

function surfaceOf(slot: "bottom" | "right") {
  const region = screen
    .getAllByTestId("terminal-dock-region")
    .find((element) => element.getAttribute("data-position") === slot)
  return region?.querySelector<HTMLElement>('[data-testid="terminal-dock-surface"]') ?? null
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  flowMotion.reduce = false
  mockDockMounts.mockClear()
  mockDockEffects = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe("TerminalDockSurfaceProvider", () => {
  it("draws one dock, inside the slot that holds it", () => {
    renderShell()
    expect(screen.queryByTestId("terminal-dock-stub")).not.toBeInTheDocument()

    act(() => {
      useTerminalStore.getState().setPanelPosition("bottom")
      useTerminalStore.getState().setPanelOpen(true)
    })

    expect(screen.getAllByTestId("terminal-dock-stub")).toHaveLength(1)
    expect(surfaceOf("bottom")).toContainElement(screen.getByTestId("terminal-dock-stub"))
  })

  it("moves the same terminal between the edges instead of rebuilding it", () => {
    renderShell()
    act(() => {
      useTerminalStore.getState().setPanelPosition("bottom")
      useTerminalStore.getState().setPanelOpen(true)
    })
    const dock = screen.getByTestId("terminal-dock-stub")
    expect(mockDockMounts).toHaveBeenCalledTimes(1)

    act(() => useTerminalStore.getState().setPanelPosition("right"))

    // The very same element, now under the right column: xterm, its renderer
    // and its PTY attachment were never disposed. A move used to unmount the
    // dock on one edge and cold-start a blank one on the other.
    expect(screen.getByTestId("terminal-dock-stub")).toBe(dock)
    expect(surfaceOf("right")).toContainElement(dock)
    expect(surfaceOf("bottom")).not.toContainElement(dock)
    expect(mockDockMounts).toHaveBeenCalledTimes(1)
    expect(mockDockEffects).toBe(1)

    act(() => useTerminalStore.getState().setPanelPosition("bottom"))
    expect(surfaceOf("bottom")).toContainElement(dock)
    expect(mockDockMounts).toHaveBeenCalledTimes(1)
  })

  it("still unmounts the dock once it has closed", () => {
    jest.useFakeTimers()
    renderShell()
    act(() => {
      useTerminalStore.getState().setPanelPosition("bottom")
      useTerminalStore.getState().setPanelOpen(true)
    })
    expect(mockDockEffects).toBe(1)

    act(() => useTerminalStore.getState().setPanelOpen(false))
    act(() => jest.advanceTimersByTime(1000))

    expect(screen.queryByTestId("terminal-dock-stub")).not.toBeInTheDocument()
    expect(mockDockEffects).toBe(0)
  })

  it("leaves no DOM of its own in the shell row", () => {
    const { container } = renderShell()
    // The rail-placement tests pin the row's child order; the provider adds
    // nothing to it, and the host node only exists inside a slot.
    expect(
      Array.from(container.children).map((child) => child.getAttribute("data-testid"))
    ).toEqual(["column", "terminal-dock-region"])
    expect(screen.queryByTestId("terminal-dock-host")).not.toBeInTheDocument()
  })
})

describe("resolveActiveSurface", () => {
  const element = document.createElement("div")
  const claim = (overrides: Partial<TerminalDockSurfaceClaim>): TerminalDockSurfaceClaim => ({
    element,
    mounted: true,
    owns: false,
    resizeBasisPx: 800,
    ...overrides,
  })

  it("is empty when no slot wants the dock", () => {
    expect(resolveActiveSurface({})).toBeNull()
    expect(resolveActiveSurface({ bottom: claim({ mounted: false }) })).toBeNull()
  })

  it("needs a surface element to draw into", () => {
    expect(resolveActiveSurface({ bottom: claim({ element: null }) })).toBeNull()
  })

  it("prefers the slot the store points at when both are mounted", () => {
    // Closing one edge and opening the other inside one collapse animation.
    const right = claim({ owns: true })
    expect(resolveActiveSurface({ bottom: claim({}), right })).toEqual({
      slot: "right",
      claim: right,
    })
  })

  it("falls back to whichever slot is still mounted", () => {
    const bottom = claim({})
    expect(resolveActiveSurface({ bottom })).toEqual({ slot: "bottom", claim: bottom })
  })
})
