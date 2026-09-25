/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
const mockReplace = jest.fn()
const mockSelect = jest.fn()
const mockFocus = jest.fn()
const mockNotFound = jest.fn()
let mockParams = new URLSearchParams("key=telegram:a1:42")
let mockSession: ChatSession | null | undefined
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockParams,
  notFound: () => mockNotFound(),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockSession }))
jest.mock("@/hooks/chat/use-sessions", () => ({ useSessions: () => ({ select: mockSelect }) }))
jest.mock("@/hooks/global-search/use-global-search-actions", () => ({
  focusSession: (...args: unknown[]) => mockFocus(...args),
}))
jest.mock("@/lib/connectors/session-bindings", () => ({
  resolveConversationLinkSession: jest.fn(),
}))
import ConversationPage from "./page"
beforeEach(() => {
  jest.clearAllMocks()
  mockParams = new URLSearchParams("key=telegram:a1:42")
  mockSession = undefined
})
it("waits for session resolution without mounting a second chat surface", () => {
  render(<ConversationPage />)
  expect(screen.getByText("Loading…")).toBeInTheDocument()
  expect(mockReplace).not.toHaveBeenCalled()
})
it("rejects missing conversation keys and unresolved targets", () => {
  mockParams = new URLSearchParams()
  const first = render(<ConversationPage />)
  expect(mockNotFound).not.toHaveBeenCalled()
  expect(screen.getByText("Conversation unavailable")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Open conversations" }))
  expect(mockReplace).toHaveBeenCalledWith("/")
  first.unmount()
  mockParams = new URLSearchParams("key=telegram:a1:42")
  mockSession = null
  render(<ConversationPage />)
  expect(mockFocus).not.toHaveBeenCalled()
  expect(screen.getByText("Conversation unavailable")).toBeInTheDocument()
})
it("keeps the way out next to the message instead of letting the empty state push it away", () => {
  mockParams = new URLSearchParams()
  render(<ConversationPage />)
  const empty = screen.getByText("Conversation unavailable").closest('[data-slot="empty"]')
  expect(empty).toHaveClass("flex-none")
  expect(empty).not.toHaveClass("flex-1")
})

it("focuses the exact resolved session before replacing the legacy route", () => {
  mockSession = { id: "older session" } as ChatSession
  render(<ConversationPage />)
  expect(mockFocus).toHaveBeenCalledWith(mockSession, "older session", mockSelect)
  expect(mockReplace).toHaveBeenCalledWith("/?session=older+session")
  expect(mockFocus.mock.invocationCallOrder[0]).toBeLessThan(
    mockReplace.mock.invocationCallOrder[0]!
  )
})
it("preserves message jumps through the shared permalink consumer", () => {
  mockSession = { id: "s1" } as ChatSession
  mockParams.set("messageId", "m 42")
  render(<ConversationPage />)
  expect(mockReplace).toHaveBeenCalledWith("/?session=s1&message=m+42")
})

it("does not redirect a missing-key link using a stale live query result", () => {
  mockParams = new URLSearchParams()
  mockSession = { id: "previous" } as ChatSession
  render(<ConversationPage />)
  expect(mockFocus).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(screen.getByText("Conversation unavailable")).toBeInTheDocument()
})
