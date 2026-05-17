/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

// Capture the props React Flow's MiniMap is invoked with.
let _lastMinimapProps: Record<string, unknown> | null = null
let renderCount = 0
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  MiniMap: (props: Record<string, unknown>) => {
    _lastMinimapProps = props
    renderCount++
    const nodeColor =
      typeof props.nodeColor === "function"
        ? (props.nodeColor as (n: { data?: { kind?: string } }) => string)({
            data: { kind: "ai.prompt" },
          })
        : undefined
    return (
      <div
        data-testid="minimap"
        data-pannable={String(props.pannable)}
        data-zoomable={String(props.zoomable)}
        data-color={nodeColor}
        className={String(props.className ?? "")}
      />
    )
  },
}))

// Re-import after the mock is installed.
import { PerfMiniMap, PERF_MINIMAP_FLAT_COLOR } from "./minimap-perf"

beforeEach(() => {
  _lastMinimapProps = null
  renderCount = 0
})

const liveColor = (n: { data?: { kind?: string } }) =>
  n.data?.kind === "ai.prompt" ? "#8b5cf6" : "#94a3b8"

describe("PerfMiniMap", () => {
  it("passes pannable+zoomable+live color when not degraded", () => {
    const { getByTestId } = render(
      <PerfMiniMap degraded={false} nodeColor={liveColor} className="rounded-md" />
    )
    const node = getByTestId("minimap")
    expect(node.getAttribute("data-pannable")).toBe("true")
    expect(node.getAttribute("data-zoomable")).toBe("true")
    expect(node.getAttribute("data-color")).toBe("#8b5cf6")
    expect(node.className).toContain("rounded-md")
  })

  it("strips listeners and swaps to the flat colour when degraded", () => {
    const { getByTestId } = render(<PerfMiniMap degraded={true} nodeColor={liveColor} />)
    const node = getByTestId("minimap")
    expect(node.getAttribute("data-pannable")).toBe("false")
    expect(node.getAttribute("data-zoomable")).toBe("false")
    expect(node.getAttribute("data-color")).toBe(PERF_MINIMAP_FLAT_COLOR)
  })

  it("does not re-render when the same props are passed again", () => {
    const { rerender } = render(
      <PerfMiniMap degraded={false} nodeColor={liveColor} className="x" />
    )
    expect(renderCount).toBe(1)
    rerender(<PerfMiniMap degraded={false} nodeColor={liveColor} className="x" />)
    expect(renderCount).toBe(1) // memo skipped the re-render
  })

  it("does re-render when degraded flips", () => {
    const { rerender } = render(<PerfMiniMap degraded={false} nodeColor={liveColor} />)
    expect(renderCount).toBe(1)
    rerender(<PerfMiniMap degraded={true} nodeColor={liveColor} />)
    expect(renderCount).toBe(2)
  })
})
