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

import { ConversationActivityLog } from "./conversation-activity-log"

const ENTRIES = [
  { id: "e1", kind: "inbound.edited", at: 1_700_000_000_000, adapterId: "a1" },
  { id: "e2", kind: "inbound.member_added", at: 1_700_000_001_000, adapterId: "a1" },
]

describe("ConversationActivityLog", () => {
  beforeEach(() => mockActivity.mockReturnValue(ENTRIES))

  it("renders nothing when there is no activity", () => {
    mockActivity.mockReturnValue([])
    const { container } = render(<ConversationActivityLog conversationKey="ck" />)
    expect(container).toBeEmptyDOMElement()
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
})
