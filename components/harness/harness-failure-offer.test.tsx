/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { makeRun } from "@/lib/harness/test-fixtures"

let mockRuns: HarnessEvolutionRun[] | undefined = []
let mockSettings = { enabled: true, startMode: "failure-triggered", failureOfferCooldownHours: 6 }
jest.mock("@/hooks/harness/use-harness-data", () => ({
  useHarnessRuns: () => mockRuns,
  useHarnessEvolutionSettings: () => mockSettings,
}))
let mockMessages: unknown[] = []
jest.mock("@/stores/chat/chat-store", () => ({
  useSessionVisibleMessages: () => mockMessages,
}))
jest.mock("@/lib/harness/runtime/run-control", () => ({
  harnessRunHref: (id: string) => `/agents/evolution?run=${id}`,
}))
let mockDialogProps: Record<string, unknown> | undefined
jest.mock("./harness-start-run-dialog", () => ({
  HarnessStartRunDialog: (props: Record<string, unknown>) => {
    mockDialogProps = props
    return props.open ? <div data-testid="start-dialog" /> : null
  },
}))

import { HarnessFailureOffer } from "./harness-failure-offer"

const agent = { id: "agent-1", name: "Analyst" } as Character
const diagnostic = {
  id: "d1",
  at: 1,
  code: "budgetExhausted",
  severity: "warning",
  retryable: false,
} as never

beforeEach(() => {
  localStorage.clear()
  mockRuns = []
  mockSettings = { enabled: true, startMode: "failure-triggered", failureOfferCooldownHours: 6 }
  mockMessages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Summarise the CSV files into report.md" }],
    },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "…" }] },
  ]
  mockDialogProps = undefined
})

describe("HarnessFailureOffer", () => {
  it("offers to improve the agent on the failed request", () => {
    render(
      <HarnessFailureOffer
        sessionId="sess-1"
        agent={agent}
        diagnostic={diagnostic}
        projectId="proj-1"
        workingDirectory="/repo"
      />
    )
    expect(screen.getByTestId("harness-failure-offer")).toHaveTextContent("how Analyst is set up")
    fireEvent.click(screen.getByText("Improve"))
    expect(screen.getByTestId("start-dialog")).toBeInTheDocument()
    expect(mockDialogProps).toMatchObject({
      trigger: "failure-triggered",
      sessionId: "sess-1",
      projectId: "proj-1",
      draft: {
        prompt: "Summarise the CSV files into report.md",
        isolation: "git",
        git: { sourceRoot: "/repo", projectId: "proj-1" },
        source: { kind: "session", sessionId: "sess-1", messageId: "u1" },
      },
    })
  })

  it("stays away from outages, missing agents and settings that do not offer", () => {
    const { container, rerender } = render(
      <HarnessFailureOffer
        sessionId="s"
        agent={agent}
        diagnostic={{ ...diagnostic, code: "rateLimited" }}
      />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<HarnessFailureOffer sessionId="s" agent={null} diagnostic={diagnostic} />)
    expect(container).toBeEmptyDOMElement()
    mockSettings = { ...mockSettings, startMode: "manual" }
    rerender(<HarnessFailureOffer sessionId="s" agent={agent} diagnostic={diagnostic} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("remembers a dismissal for the cooldown", () => {
    const { container } = render(
      <HarnessFailureOffer sessionId="s" agent={agent} diagnostic={diagnostic} />
    )
    act(() => fireEvent.click(screen.getByTestId("harness-failure-dismiss")))
    expect(container).toBeEmptyDOMElement()
    expect(localStorage.getItem("cognia:harness-failure-offer-dismissed:agent-1")).not.toBeNull()
  })

  it("shows the conversation's run instead of offering another", () => {
    mockRuns = [makeRun({ id: "run-5", sessionId: "s", status: "awaiting_approval", createdAt: 5 })]
    render(<HarnessFailureOffer sessionId="s" agent={agent} diagnostic={diagnostic} />)
    expect(screen.getByTestId("harness-failure-run")).toHaveTextContent("Awaiting approval")
    expect(screen.getByText("View run")).toHaveAttribute("href", "/agents/evolution?run=run-5")
  })
})
