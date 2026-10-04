/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { OTHER_TOOLS_KEY } from "@/lib/analysis/session-report"
import { ToolCallsChart } from "./tool-calls-chart"

describe("ToolCallsChart", () => {
  it("ranks tools as bars scaled to the busiest one and reports failures", () => {
    render(
      <ToolCallsChart
        rows={[
          { tool: "Bash", count: 10 },
          { tool: "Read", count: 5 },
          { tool: OTHER_TOOLS_KEY, count: 2 },
        ]}
        total={17}
        errors={3}
      />
    )
    expect(screen.getByText("17 calls")).toBeInTheDocument()
    expect(screen.getByTestId("tool-calls-errors")).toHaveTextContent("3 failed (18%)")
    const read = screen.getByTestId("tool-calls-row-Read")
    expect(read.querySelector("span span")).toHaveStyle({ width: "50%" })
    expect(screen.getByTestId(`tool-calls-row-${OTHER_TOOLS_KEY}`)).toHaveTextContent("Other")
  })

  it("explains a conversation without tool calls", () => {
    render(<ToolCallsChart rows={[]} total={0} errors={0} />)
    expect(screen.getByTestId("tool-calls-empty")).toBeInTheDocument()
  })
})
