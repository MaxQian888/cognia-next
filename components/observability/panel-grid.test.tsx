/**
 * @jest-environment jsdom
 */
import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { PanelGrid } from "./panel-grid"
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
  }: {
    children: ReactNode
    onLayoutChange: (layout: unknown, all: unknown) => void
    dragConfig?: { enabled?: boolean }
  }) => (
    <div data-testid="rgl" data-draggable={String(dragConfig?.enabled)}>
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

  it("coerces layout changes to the persisted shape", () => {
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
    expect(onLayoutChange).toHaveBeenCalledWith({
      lg: [{ i: "kpi-cost", x: 1, y: 2, w: 3, h: 4, minW: undefined, minH: undefined }],
      md: [],
      sm: [],
    })
  })
})
