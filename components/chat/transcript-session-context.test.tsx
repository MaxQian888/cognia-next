import { render, screen } from "@testing-library/react"
import { TranscriptSessionProvider, useTranscriptSessionId } from "./transcript-session-context"

function Probe() {
  return <span data-testid="probe">{useTranscriptSessionId() ?? "none"}</span>
}

describe("TranscriptSessionProvider", () => {
  it("is null outside a transcript", () => {
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("none")
  })

  it("gives the nearest transcript's session, inner lists winning", () => {
    render(
      <TranscriptSessionProvider sessionId="outer">
        <TranscriptSessionProvider sessionId="pane">
          <Probe />
        </TranscriptSessionProvider>
      </TranscriptSessionProvider>
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("pane")
  })

  it("treats a missing session as none", () => {
    render(
      <TranscriptSessionProvider sessionId={undefined}>
        <Probe />
      </TranscriptSessionProvider>
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("none")
  })
})
