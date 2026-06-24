/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { createRef } from "react"
import { render, screen, act } from "@testing-library/react"

// `ViewportPortal` normally portals into the React Flow viewport; render its
// children inline so the SVG is queryable in jsdom.
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import {
  AlignmentOverlay,
  AlignmentGuidesLayer,
  type AlignmentGuidesHandle,
} from "./alignment-overlay"
import type { GuidesResult } from "@/lib/workflow/editor/alignment-guides"

function guides(overrides: Partial<GuidesResult> = {}): GuidesResult {
  return {
    vertical: [{ x: 100, yStart: 0, yEnd: 200, source: "center", peerId: "n_peer" }],
    horizontal: [{ y: 50, xStart: 0, xEnd: 300, source: "middle", peerId: "n_peer" }],
    snap: { dx: 0, dy: 0 },
    ...overrides,
  }
}

describe("AlignmentOverlay", () => {
  it("renders nothing when guides are null", () => {
    render(<AlignmentOverlay guides={null} />)
    expect(screen.queryByTestId("alignment-overlay")).not.toBeInTheDocument()
  })

  it("renders nothing when both guide lists are empty", () => {
    render(<AlignmentOverlay guides={guides({ vertical: [], horizontal: [] })} />)
    expect(screen.queryByTestId("alignment-overlay")).not.toBeInTheDocument()
  })

  it("renders the vertical and horizontal guide lines", () => {
    render(<AlignmentOverlay guides={guides()} />)
    expect(screen.getByTestId("alignment-overlay")).toBeInTheDocument()
    expect(screen.getByTestId("alignment-guide-v-center")).toBeInTheDocument()
    expect(screen.getByTestId("alignment-guide-h-middle")).toBeInTheDocument()
  })
})

describe("AlignmentGuidesLayer", () => {
  it("renders nothing until guides are pushed through the imperative handle", () => {
    const ref = createRef<AlignmentGuidesHandle>()
    render(<AlignmentGuidesLayer ref={ref} />)
    expect(screen.queryByTestId("alignment-overlay")).not.toBeInTheDocument()

    act(() => ref.current!.setGuides(guides()))
    expect(screen.getByTestId("alignment-overlay")).toBeInTheDocument()
  })

  it("clears the overlay when null is pushed", () => {
    const ref = createRef<AlignmentGuidesHandle>()
    render(<AlignmentGuidesLayer ref={ref} />)
    act(() => ref.current!.setGuides(guides()))
    expect(screen.getByTestId("alignment-overlay")).toBeInTheDocument()

    act(() => ref.current!.setGuides(null))
    expect(screen.queryByTestId("alignment-overlay")).not.toBeInTheDocument()
  })
})
