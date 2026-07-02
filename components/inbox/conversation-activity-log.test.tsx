/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

beforeAll(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

const mockActivity = jest.fn()
jest.mock("@/hooks/connectors/use-conversation-activity", () => ({
  useConversationActivity: () => mockActivity(),
}))
const mockAssignment = jest.fn()
jest.mock("@/hooks/connectors/use-conversation-assignment-events", () => ({
  useConversationAssignmentEvents: () => mockAssignment(),
}))

import { ConversationActivityLog } from "./conversation-activity-log"

const ENTRIES = [
  { id: "e1", kind: "inbound.edited", at: 1_700_000_000_000, adapterId: "a1" },
  { id: "e2", kind: "inbound.member_added", at: 1_700_000_001_000, adapterId: "a1" },
]

describe("ConversationActivityLog", () => {
  beforeEach(() => {
    mockActivity.mockReturnValue(ENTRIES)
    mockAssignment.mockReturnValue([])
  })

  it("renders nothing when there is no activity", () => {
    mockActivity.mockReturnValue([])
    const { container } = render(<ConversationActivityLog conversationKey="ck" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("interleaves assignment-trail events with audit rows", () => {
    mockActivity.mockReturnValue([])
    mockAssignment.mockReturnValue([
      { id: "as1", conversationKey: "ck", kind: "assigned", at: 1_700_000_002_000 },
      { id: "as2", conversationKey: "ck", kind: "status.resolved", at: 1_700_000_003_000 },
    ])
    render(<ConversationActivityLog conversationKey="ck" />)
    fireEvent.click(screen.getByTestId("activity-log-toggle"))
    expect(screen.getByTestId("activity-row-as1")).toHaveTextContent("Assigned")
    expect(screen.getByTestId("activity-row-as2")).toHaveTextContent("Resolved")
  })

  it("renders a collapsed toggle with the event count", () => {
    render(<ConversationActivityLog conversationKey="ck" />)
    expect(screen.getByTestId("activity-log-toggle")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-log-list")).not.toBeInTheDocument()
  })

  it("expands to show one row per event with translated labels", () => {
    render(<ConversationActivityLog conversationKey="ck" />)
    fireEvent.click(screen.getByTestId("activity-log-toggle"))
    expect(screen.getByTestId("activity-log-list")).toBeInTheDocument()
    expect(screen.getByTestId("activity-row-e1")).toHaveTextContent("Message edited")
    expect(screen.getByTestId("activity-row-e2")).toHaveTextContent("Member joined")
  })

  it("falls back to the raw kind for an unmapped audit kind", () => {
    mockActivity.mockReturnValue([
      { id: "e9", kind: "some.unmapped.kind", at: 1_700_000_009_000, adapterId: "a1" },
    ])
    render(<ConversationActivityLog conversationKey="ck" />)
    fireEvent.click(screen.getByTestId("activity-log-toggle"))
    expect(screen.getByTestId("activity-row-e9")).toHaveTextContent("some.unmapped.kind")
  })

  it("labels a silent-reply diagnostic kind and appends its reason", () => {
    mockActivity.mockReturnValue([
      {
        id: "e3",
        kind: "inbound.policy_blocked",
        reason: "at_mention_required",
        at: 1_700_000_004_000,
        adapterId: "a1",
      },
    ])
    render(<ConversationActivityLog conversationKey="ck" />)
    fireEvent.click(screen.getByTestId("activity-log-toggle"))
    const row = screen.getByTestId("activity-row-e3")
    expect(row).toHaveTextContent("Blocked by policy")
    expect(row).toHaveTextContent("at_mention_required")
  })
})
