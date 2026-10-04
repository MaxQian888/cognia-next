/**
 * @jest-environment jsdom
 */
import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { PanelGrid, mergeHidden } from "./panel-grid"
import { defaultLayouts, PANELS } from "./panel-registry"

// Mock RGL (v2) to a passthrough: a stable container-width + a grid that
// renders children and exposes a button to fire onLayoutChange. JSX uses the
// automatic runtime, so no React import is needed inside the factory.
jest.mock("react-grid-layout", () => ({
  useContainerWidth: () => ({ width: 1000, containerRef: { current: null }, mounted: true }),
  ResponsiveGridLayout: ({
    children,
    onLayoutChange,
    dragConfig,
    layouts,
  }: {
    children: ReactNode
    onLayoutChange: (layout: unknown, all: unknown) => void
    dragConfig?: { enabled?: boolean }
    layouts: { lg: unknown[]; md: unknown[]; sm: unknown[] }
  }) => (
    <div
      data-testid="rgl"
      data-draggable={String(dragConfig?.enabled)}
      data-lg-count={String(layouts.lg.length)}
    >
      <button
        data-testid="rgl-fire-change"
        onClick={() =>
          onLayoutChange([], {
            lg: [{ i: "kpi-cost", x: 1, y: 2, w: 3, h: 4 }],
            md: [],
            sm: [],
          })
        }
      >
        change
      </button>
      {children}
    </div>
  ),
}))

describe("PanelGrid", () => {
  it("renders a cell for every registered panel", () => {
    render(
      <PanelGrid
        layouts={defaultLayouts()}
        editMode={false}
        onLayoutChange={jest.fn()}
        renderPanel={(p) => <div data-testid={`cell-${p.id}`}>{p.id}</div>}
      />
    )
    for (const p of PANELS) {
      expect(screen.getByTestId(`cell-${p.id}`)).toBeInTheDocument()
    }
  })

  it("skips hidden panels", () => {
    render(
      <PanelGrid
        layouts={defaultLayouts()}
        editMode={false}
        hiddenPanels={["ts-tokens", "bd-tool"]}
        onLayoutChange={jest.fn()}
        renderPanel={(p) => <div data-testid={`cell-${p.id}`}>{p.id}</div>}
      />
    )
    expect(screen.getByTestId("cell-kpi-cost")).toBeInTheDocument()
    expect(screen.queryByTestId("cell-ts-tokens")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cell-bd-tool")).not.toBeInTheDocument()
  })

  it("passes editMode through to draggability", () => {
    render(
      <PanelGrid
        layouts={defaultLayouts()}
        editMode
        onLayoutChange={jest.fn()}
        renderPanel={() => null}
      />
    )
    expect(screen.getByTestId("rgl")).toHaveAttribute("data-draggable", "true")
  })

  it("persists RGL's report merged back into the complete layout", () => {
    const onLayoutChange = jest.fn()
    render(
      <PanelGrid
        layouts={defaultLayouts()}
        editMode
        onLayoutChange={onLayoutChange}
        renderPanel={() => null}
      />
    )
    fireEvent.click(screen.getByTestId("rgl-fire-change"))
    const saved = onLayoutChange.mock.calls[0][0]
    // The moved tile keeps its new geometry, with the registry's min sizes.
    expect(saved.lg[0]).toEqual({ i: "kpi-cost", x: 1, y: 2, w: 3, h: 4, minW: 2, minH: 2 })
    // Every other panel survives — RGL only reported one.
    for (const bp of ["lg", "md", "sm"] as const) {
      expect(saved[bp]).toHaveLength(PANELS.length)
    }
  })

  it("hands RGL a complete layout even when the stored one is missing panels", () => {
    const partial = { ...defaultLayouts(), lg: defaultLayouts().lg.slice(0, 3) }
    render(
      <PanelGrid
        layouts={partial}
        editMode={false}
        onLayoutChange={jest.fn()}
        renderPanel={() => null}
      />
    )
    expect(screen.getByTestId("rgl")).toHaveAttribute("data-lg-count", String(PANELS.length))
  })
})

describe("mergeHidden", () => {
  const previous = defaultLayouts()

  it("keeps a hidden panel's position when RGL reports only the visible ones", () => {
    const hiddenBefore = previous.lg.find((item) => item.i === "bd-tool")!
    const visible = previous.lg.filter((item) => item.i !== "bd-tool")
    const merged = mergeHidden({ lg: visible, md: previous.md, sm: previous.sm }, previous)
    expect(merged.lg.find((item) => item.i === "bd-tool")).toEqual(hiddenBefore)
  })

  it("leaves a breakpoint RGL did not report untouched", () => {
    const merged = mergeHidden({ lg: [{ i: "kpi-cost", x: 5, y: 0, w: 2, h: 2 }] }, previous)
    expect(merged.md).toEqual(previous.md)
    expect(merged.sm).toEqual(previous.sm)
  })

  it("clamps an undersized reported tile back to the registry minimum", () => {
    const merged = mergeHidden({ lg: [{ i: "ts-cost", x: 0, y: 0, w: 1, h: 1 }] }, previous)
    expect(merged.lg.find((item) => item.i === "ts-cost")).toMatchObject({ w: 3, h: 4 })
  })
})
