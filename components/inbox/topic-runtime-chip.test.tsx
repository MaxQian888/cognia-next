/** @jest-environment jsdom */

import { useEffect, useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => mockUseLiveQuery(...args),
}))
jest.mock("@/components/ui/tooltip")

const mockGetDb = jest.fn()
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockGetDb() }))

const mockResolveInboundActivationPolicy = jest.fn((..._args: unknown[]) => "mention_activates")
const mockResolveDeliveryReadiness = jest.fn((..._args: unknown[]) => "all_messages_verified")
jest.mock("@/lib/connectors/conversation-admission", () => ({
  resolveInboundActivationPolicy: (...args: unknown[]) =>
    mockResolveInboundActivationPolicy(...args),
  resolveDeliveryReadiness: (...args: unknown[]) => mockResolveDeliveryReadiness(...args),
}))

const mockCapabilitiesForScope = jest.fn((..._args: unknown[]) => ({
  topicIsolation: "native",
  textStreaming: true,
  componentMutation: true,
  messageEditing: true,
  interactiveControls: true,
  followUpBubbles: false,
}))
jest.mock("@/types/connectors/runtime-capability", () => ({
  connectorRuntimeCapabilitiesForScope: (...args: unknown[]) => mockCapabilitiesForScope(...args),
}))

function useLiveQueryHarness<T>(query: () => Promise<T>, dependencies: unknown[]): T | undefined {
  const [value, setValue] = useState<T>()
  const [initialQuery] = useState(() => query)
  const adapterId = dependencies[0]
  const conversationKey = dependencies[1]
  useEffect(() => {
    let active = true
    void initialQuery().then((next) => {
      if (active) setValue(next)
    })
    return () => {
      active = false
    }
  }, [adapterId, conversationKey, initialQuery])
  return value
}

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
    expect(screen.getByText(/Requested: mention_activates/)).toBeInTheDocument()
    expect(screen.getByText(/Queue depth: 3/)).toBeInTheDocument()
    expect(screen.getByText(/delivery is unverified/i)).toBeInTheDocument()
  })

  it("resolves topic presentation features with thread scope", async () => {
    const emptyQuery = {
      where: jest.fn(() => ({
        equals: jest.fn(() => ({
          first: jest.fn(async () => undefined),
          toArray: jest.fn(async () => []),
        })),
      })),
    }
    mockGetDb.mockReturnValue({
      adapterInstances: { get: jest.fn(async () => ({ type: "lark" })) },
      connectorConversationStates: { get: jest.fn(async () => undefined) },
      conversationOverrides: emptyQuery,
      connectorInboundJobs: emptyQuery,
      executionRunBindings: emptyQuery,
    })
    mockUseLiveQuery.mockImplementation(useLiveQueryHarness)

    render(<TopicRuntimeChip adapterId="lk-1" conversationKey="opaque-topic" />)

    await waitFor(() => expect(screen.getByTestId("topic-runtime-chip")).toBeInTheDocument())
    expect(mockCapabilitiesForScope).toHaveBeenCalledWith("lark", "thread")
  })
})
