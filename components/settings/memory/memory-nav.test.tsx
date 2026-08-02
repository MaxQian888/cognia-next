/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { MemoryNav } from "./memory-nav"

let reduce = true
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, durationScale: 1 }),
}))

beforeEach(() => {
  reduce = true
})

describe("MemoryNav", () => {
  it("marks the active item and selects another panel", () => {
    const onSelect = jest.fn()
    render(<MemoryNav activeId="overview" onSelect={onSelect} />)

    expect(screen.getByTestId("memory-nav-item-overview")).toHaveAttribute("aria-current", "true")
    fireEvent.click(screen.getByTestId("memory-nav-item-learning"))
    expect(onSelect).toHaveBeenCalledWith("learning")
  })

  it("surfaces conflict and degraded-retrieval badges", () => {
    render(
      <MemoryNav activeId="overview" onSelect={jest.fn()} conflictCount={3} retrievalDegraded />
    )

    expect(screen.getByTestId("memory-nav-badge-overview")).toHaveTextContent("3")
    expect(screen.getByTestId("memory-nav-badge-retrieval")).toHaveTextContent("!")
  })

  it("paints the active row's own background when motion is reduced", () => {
    // Under `reduce` the shared-layout pill is dropped — only one element may
    // ever carry a layoutId — so the row has to supply the highlight itself.
    render(<MemoryNav activeId="privacy" onSelect={jest.fn()} />)

    expect(screen.getByTestId("memory-nav-item-privacy").className).toContain("bg-accent")
  })

  it("defers the highlight to the sliding pill when motion is allowed", () => {
    reduce = false
    render(<MemoryNav activeId="privacy" onSelect={jest.fn()} />)

    const row = screen.getByTestId("memory-nav-item-privacy")
    expect(row.className).not.toContain("bg-accent ")
    expect(row.className).toContain("text-accent-foreground")
  })

  // The Sheet copy and the desktop rail are mounted at the same time below
  // `md`, so each needs its own id space — testids and the pill's layoutId
  // alike.
  it("namespaces its rows under a caller-supplied prefix", () => {
    render(
      <MemoryNav activeId="overview" onSelect={jest.fn()} conflictCount={2} idPrefix="sheet" />
    )

    expect(screen.getByTestId("sheet-nav-item-overview")).toBeInTheDocument()
    expect(screen.getByTestId("sheet-nav-badge-overview")).toHaveTextContent("2")
    expect(screen.queryByTestId("memory-nav-item-overview")).not.toBeInTheDocument()
  })
})
