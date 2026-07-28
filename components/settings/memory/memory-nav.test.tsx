/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { MemoryNav } from "./memory-nav"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))

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
})
