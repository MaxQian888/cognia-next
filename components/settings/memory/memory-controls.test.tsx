/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { GatedGroup, MemoryToggleRow } from "./memory-controls"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

describe("MemoryToggleRow", () => {
  it("exposes an accessible switch and emits changes", () => {
    const onCheckedChange = jest.fn()
    render(
      <MemoryToggleRow
        id="memory-test"
        label="Use memories"
        description="Recall saved facts."
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    )

    fireEvent.click(screen.getByRole("switch", { name: "Use memories" }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})

describe("GatedGroup", () => {
  it("makes a gated subtree inert and explains why", () => {
    render(
      <GatedGroup gated reason="Turn memory on">
        <button type="button">Nested control</button>
      </GatedGroup>
    )

    expect(screen.getByTestId("memory-gate-reason")).toHaveTextContent("Turn memory on")
    expect(screen.getByRole("button", { name: "Nested control" }).parentElement).toHaveAttribute(
      "inert"
    )
  })
})
