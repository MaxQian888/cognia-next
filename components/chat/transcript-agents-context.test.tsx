import { render, screen } from "@testing-library/react"
import {
  TranscriptAgentsProvider,
  useTranscriptHasMultipleAgents,
} from "./transcript-agents-context"

function Probe() {
  return <span data-testid="probe">{String(useTranscriptHasMultipleAgents())}</span>
}

describe("TranscriptAgentsProvider", () => {
  it("defaults to false outside any transcript", () => {
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("false")
  })

  it("hands its answer to every message below it and follows updates", () => {
    const { rerender } = render(
      <TranscriptAgentsProvider multiAgent={false}>
        <Probe />
      </TranscriptAgentsProvider>
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("false")
    rerender(
      <TranscriptAgentsProvider multiAgent>
        <Probe />
      </TranscriptAgentsProvider>
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("true")
  })
})
