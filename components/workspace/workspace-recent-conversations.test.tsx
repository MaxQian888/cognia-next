/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

let sessionsResult: ChatSession[] | undefined = []
const queriedWith: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_fn: () => unknown, deps: unknown[]) => {
    queriedWith.push(deps[0])
    return sessionsResult
  },
}))
jest.mock("@/lib/db/sessions", () => ({ listWorkspaceSessions: jest.fn() }))
const startNewSessionMock = jest.fn()
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...a: unknown[]) => startNewSessionMock(...a),
}))

import {
  RECENT_CONVERSATION_LIMIT,
  recentConversations,
  WorkspaceRecentConversations,
} from "./workspace-recent-conversations"

const NOW = Date.parse("2026-09-25T12:00:00Z")

function session(over: Partial<ChatSession> & Record<string, unknown>): ChatSession {
  return { id: "s", title: "A chat", createdAt: NOW, updatedAt: NOW, ...over } as ChatSession
}

beforeEach(() => {
  sessionsResult = []
  queriedWith.length = 0
  routerPush.mockClear()
  toastError.mockClear()
  startNewSessionMock.mockReset()
})

describe("recentConversations", () => {
  it("keeps what the chat list shows, newest activity first", () => {
    const rows = recentConversations([
      session({ id: "old", updatedAt: NOW - 3_000 }),
      // A newer message beats a newer row write.
      session({ id: "talked", updatedAt: NOW - 5_000, lastMessageAt: NOW }),
      session({ id: "archived", archivedAt: NOW }),
      session({ id: "im", platformBinding: { platform: "telegram" } as never }),
      session({ id: "sub", kind: "subagent" }),
    ])
    expect(rows.map((row) => row.id)).toEqual(["talked", "old"])
  })
})

describe("WorkspaceRecentConversations", () => {
  it("waits for the read instead of saying there are none", () => {
    sessionsResult = undefined
    render(<WorkspaceRecentConversations workspaceId="w1" />)
    expect(screen.getByTestId("workspace-conversations-loading")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByTestId("workspace-conversations-empty")).not.toBeInTheDocument()
  })

  it("says so when the workspace has no conversations", () => {
    render(<WorkspaceRecentConversations workspaceId="w1" />)
    expect(screen.getByTestId("workspace-conversations-empty")).toHaveTextContent(
      "No conversations in this workspace yet."
    )
  })

  it("links the newest few to their conversation and hands the rest to the chat list", () => {
    sessionsResult = Array.from({ length: RECENT_CONVERSATION_LIMIT + 2 }, (_, i) =>
      session({ id: `s${i}`, title: i === 0 ? "  " : `Chat ${i}`, updatedAt: NOW - i * 1_000 })
    )
    render(<WorkspaceRecentConversations workspaceId="w1" />)

    const list = screen.getByTestId("workspace-conversations-list")
    expect(list.querySelectorAll("li")).toHaveLength(RECENT_CONVERSATION_LIMIT)
    expect(screen.getByTestId("workspace-conversation-s1")).toHaveAttribute("href", "/?session=s1")
    // A blank title is named rather than rendered as an empty row.
    expect(screen.getByTestId("workspace-conversation-s0")).toHaveTextContent(
      "Untitled conversation"
    )
    expect(screen.getByTestId("workspace-conversations-all")).toHaveAttribute("href", "/")
    expect(screen.getByTestId("workspace-conversations-all")).toHaveTextContent(
      `Open all ${RECENT_CONVERSATION_LIMIT + 2} conversations`
    )
    expect(queriedWith).toContain("w1")
  })

  it("starts a conversation in THIS workspace and goes to it", async () => {
    startNewSessionMock.mockResolvedValue({ id: "new" })
    render(<WorkspaceRecentConversations workspaceId="w1" />)

    fireEvent.click(screen.getByTestId("workspace-conversations-new"))

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"))
    expect(startNewSessionMock).toHaveBeenCalledWith({ projectId: "w1" })
  })

  it("starts one conversation for a double click, not two", async () => {
    let finish!: () => void
    startNewSessionMock.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ id: "new" })))
    )
    render(<WorkspaceRecentConversations workspaceId="w1" />)
    const button = screen.getByTestId("workspace-conversations-new")

    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    finish()

    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1))
    expect(startNewSessionMock).toHaveBeenCalledTimes(1)
  })

  it("says why a conversation could not be started", async () => {
    startNewSessionMock.mockRejectedValue(new Error("db closed"))
    render(<WorkspaceRecentConversations workspaceId="w1" />)

    fireEvent.click(screen.getByTestId("workspace-conversations-new"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("db closed")
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("offers nothing to start without a workspace", () => {
    render(<WorkspaceRecentConversations workspaceId={null} />)
    expect(screen.getByTestId("workspace-conversations-new")).toBeDisabled()
  })
})
