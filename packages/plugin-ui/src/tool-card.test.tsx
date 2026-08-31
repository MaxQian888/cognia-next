import { render, renderHook, screen } from "@testing-library/react"

import { parseToolOutput, ToolCard, useParsedToolOutput } from "./tool-card"

describe("ToolCard", () => {
  it("renders themed card chrome, badge, action, and content", () => {
    render(
      <ToolCard title="Search" badge="3" action={<button type="button">Open</button>} testId="card">
        Result
      </ToolCard>
    )
    expect(screen.getByTestId("card")).toHaveAttribute("data-slot", "plugin-tool-card")
    expect(screen.getByTestId("card-badge")).toHaveTextContent("3")
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument()
    expect(screen.getByText("Result")).toBeInTheDocument()
  })
})

describe("tool output parsing", () => {
  it("accepts objects and JSON strings while rejecting invalid output", () => {
    expect(parseToolOutput({ ok: true })).toEqual({ ok: true })
    expect(parseToolOutput('{"ok":true}')).toEqual({ ok: true })
    expect(parseToolOutput("not-json")).toBeNull()
    expect(parseToolOutput(" ")).toBeNull()
  })

  it("exposes a memoized typed hook", () => {
    const { result, rerender } = renderHook(
      ({ output }) => useParsedToolOutput<{ count: number }>(output),
      {
        initialProps: { output: '{"count":2}' as unknown },
      }
    )
    expect(result.current).toEqual({ count: 2 })
    rerender({ output: null })
    expect(result.current).toBeNull()
  })
})
