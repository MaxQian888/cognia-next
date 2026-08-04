import React from "react"
import { render, waitFor } from "@testing-library/react"

import { VirtualizedTranscript } from "./VirtualizedTranscript"
import type { Cell } from "../state/types"

describe("VirtualizedTranscript", () => {
  it("renders only the visible window plus overscan", () => {
    const cells: Cell[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `c${index}`,
      kind: "notice" as const,
      message: `message-${index}`,
    }))
    const { container } = render(
      <VirtualizedTranscript
        cells={cells}
        width={80}
        top={1000}
        viewportRows={20}
        verbose={false}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("message-500")
    expect(text).not.toContain("message-0")
    expect(text).not.toContain("message-999")
    expect(container.querySelectorAll('[data-testid="terminal-block"]').length).toBeLessThan(100)
  })

  it("renders all rows before the viewport has been measured", () => {
    const cells: Cell[] = [
      { id: "a", kind: "notice", message: "first" },
      { id: "b", kind: "notice", message: "second" },
    ]
    const { container } = render(
      <VirtualizedTranscript cells={cells} width={40} top={0} viewportRows={0} verbose={false} />
    )
    expect(container.textContent).toContain("first")
    expect(container.textContent).toContain("second")
  })

  it("reserves the terminal auto-wrap column so the next row keeps its first character", async () => {
    const onMetrics = jest.fn()
    render(
      <VirtualizedTranscript
        cells={[{ id: "a", kind: "assistant", raw: "A".repeat(40) }]}
        width={40}
        top={0}
        viewportRows={10}
        verbose={false}
        onMetrics={onMetrics}
      />
    )
    await waitFor(() => expect(onMetrics).toHaveBeenCalled())
    expect(onMetrics.mock.calls.at(-1)?.[0]).toEqual([{ id: "a", rows: 3 }])
  })
})
