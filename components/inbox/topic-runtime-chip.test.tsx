/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => mockUseLiveQuery(...args),
}))
jest.mock("@/components/ui/tooltip")

import { TopicRuntimeChip } from "./topic-runtime-chip"

describe("TopicRuntimeChip", () => {
  it("renders nothing while the diagnostic is unavailable", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    const { container } = render(<TopicRuntimeChip adapterId="lk-1" conversationKey="opaque" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows effective dispatch and full diagnostic details", () => {
    mockUseLiveQuery.mockReturnValue({
      requested: "mention_activates",
      effective: "mention_each",
      readiness: "mentions_only",
      dispatch: "steer",
      active: false,
      queueDepth: 3,
      recoveryCount: 1,
      activeRunId: "run-1",
      fallback: "delivery_unverified",
      capabilities: {
        topicIsolation: "native",
        textStreaming: true,
        componentMutation: true,
        messageEditing: true,
        interactiveControls: true,
      },
    })
    render(<TopicRuntimeChip adapterId="lk-1" conversationKey="opaque" />)
    expect(screen.getByTestId("topic-runtime-chip")).toHaveTextContent("mention_each · steer")
    expect(screen.getByText(/Requested policy: mention_activates/)).toBeInTheDocument()
    expect(screen.getByText(/Queue depth: 3/)).toBeInTheDocument()
    expect(screen.getByText(/unmentioned delivery is not verified/i)).toBeInTheDocument()
  })
})
