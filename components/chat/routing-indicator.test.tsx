/**
 * @jest-environment jsdom
 */

import { render as rtlRender, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { RoutingIndicator } from "./routing-indicator"
import type { MessageRunMetadata } from "@/lib/chat/message-run-metadata"

// `TooltipProvider` is mounted app-wide in `app/layout.tsx`; supply it here.
const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

function routing(
  over: Partial<NonNullable<MessageRunMetadata["routing"]>> = {}
): NonNullable<MessageRunMetadata["routing"]> {
  return {
    mode: "auto",
    strategy: "quality",
    reasonCodes: ["auto-task-fit"],
    candidateCount: 3,
    ...over,
  }
}

describe("RoutingIndicator", () => {
  it("renders nothing for a manual selection", () => {
    const { container } = render(<RoutingIndicator routing={routing({ mode: "manual" })} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("routing-indicator")).toBeNull()
  })

  it("labels an auto selection with its resolved alias", () => {
    render(<RoutingIndicator routing={routing({ alias: "code-tier" })} />)
    expect(screen.getByTestId("routing-indicator")).toHaveTextContent("Auto · code-tier")
  })

  it("falls back to the tier when an auto selection carries no alias", () => {
    render(<RoutingIndicator routing={routing({ tier: "balanced" })} />)
    expect(screen.getByTestId("routing-indicator")).toHaveTextContent("Auto · balanced")
  })

  it("labels an alias selection with the alias name", () => {
    render(<RoutingIndicator routing={routing({ mode: "alias", alias: "fast" })} />)
    expect(screen.getByTestId("routing-indicator")).toHaveTextContent("Alias · fast")
  })

  it("labels an alias selection that carries no alias name", () => {
    render(<RoutingIndicator routing={routing({ mode: "alias" })} />)
    expect(screen.getByTestId("routing-indicator")).toHaveTextContent("Alias · alias")
  })

  it("marks the chip when the cost cap was exceeded", () => {
    render(
      <RoutingIndicator
        routing={routing({ reasonCodes: ["auto-task-fit", "cost-cap-exceeded"] })}
      />
    )
    expect(screen.getByTestId("routing-indicator").className).toContain("text-amber-600")
  })

  it("explains the decision in the tooltip: strategy, tier, score, judge, candidates, reasons", async () => {
    const user = userEvent.setup()
    render(
      <RoutingIndicator
        routing={routing({
          tier: "fast",
          score: 0.1234,
          judgeUsed: true,
          reasonCodes: ["auto-task-fit", "judge-agreed"],
        })}
      />
    )
    await user.hover(screen.getByTestId("routing-indicator"))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Strategy: quality")
    expect(tooltip).toHaveTextContent("Tier: fast")
    expect(tooltip).toHaveTextContent("Score: 0.12")
    expect(tooltip).toHaveTextContent("Judge: yes")
    expect(tooltip).toHaveTextContent("Candidates: 3")
    expect(tooltip).toHaveTextContent("Automatic task fit")
    expect(tooltip).toHaveTextContent("Difficulty judge agreed")
  })

  it("reports when the judge was consulted and did not run", async () => {
    const user = userEvent.setup()
    render(<RoutingIndicator routing={routing({ judgeUsed: false })} />)
    await user.hover(screen.getByTestId("routing-indicator"))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Judge: no")
  })

  it("localizes templated plugin/filter reason codes like the routing workbench", async () => {
    const user = userEvent.setup()
    render(
      <RoutingIndicator
        routing={routing({ reasonCodes: ["plugin:vision-filter:veto", "filter:my-filter"] })}
      />
    )
    await user.hover(screen.getByTestId("routing-indicator"))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Plugin decision (plugin:vision-filter:veto)")
    expect(tooltip).toHaveTextContent("Filter decision (filter:my-filter)")
  })

  it("shows the over-cap warning line in the tooltip", async () => {
    const user = userEvent.setup()
    render(<RoutingIndicator routing={routing({ reasonCodes: ["cost-cap-exceeded"] })} />)
    await user.hover(screen.getByTestId("routing-indicator"))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Proceeded over the per-request cost cap")
  })
})
