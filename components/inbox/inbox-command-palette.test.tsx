/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockUseLiveQuery(),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { InboxCommandPalette } from "./inbox-command-palette"

const SESSIONS = [
  {
    id: "s1",
    title: "Product team",
    updatedAt: 200,
    platformBinding: { platform: "slack", adapterId: "a1", conversationKey: "slack:a1:C1" },
  },
  {
    id: "s2",
    title: "Alice",
    updatedAt: 100,
    platformBinding: { platform: "lark", adapterId: "a2", conversationKey: "lark:a2:U9" },
  },
]

describe("InboxCommandPalette", () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockUseLiveQuery.mockReturnValue(SESSIONS)
  })

  function openWithShortcut() {
    render(<InboxCommandPalette />)
    fireEvent.keyDown(window, { key: "k", metaKey: true })
  }

  it("is closed until ⌘K is pressed", () => {
    render(<InboxCommandPalette />)
    expect(screen.queryByTestId("inbox-command-input")).not.toBeInTheDocument()
  })

  it("opens on ⌘K and lists platform-bound conversations", () => {
    openWithShortcut()
    expect(screen.getByTestId("inbox-command-input")).toBeInTheDocument()
    expect(screen.getByTestId("inbox-command-item-slack:a1:C1")).toBeInTheDocument()
    expect(screen.getByTestId("inbox-command-item-lark:a2:U9")).toBeInTheDocument()
  })

  it("opens on Ctrl+K as well", () => {
    render(<InboxCommandPalette />)
    fireEvent.keyDown(window, { key: "K", ctrlKey: true })
    expect(screen.getByTestId("inbox-command-input")).toBeInTheDocument()
  })

  it("navigates to the conversation route on select", () => {
    openWithShortcut()
    fireEvent.click(screen.getByTestId("inbox-command-item-slack:a1:C1"))
    expect(mockPush).toHaveBeenCalledWith("/inbox/c/slack%3Aa1%3AC1")
  })

  it("renders without rows when there are no sessions", () => {
    mockUseLiveQuery.mockReturnValue([])
    openWithShortcut()
    expect(screen.getByTestId("inbox-command-input")).toBeInTheDocument()
    expect(screen.queryByTestId("inbox-command-item-slack:a1:C1")).not.toBeInTheDocument()
  })
})
