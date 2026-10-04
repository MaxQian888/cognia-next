/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

// next-intl is globally mocked against en.json in jest.setup.ts; its
// `relativeTime` renders the instant as an ISO string.

jest.mock("@/hooks/chat/use-session-archive-actions", () => {
  const unarchive = jest.fn(async () => true)
  const archive = jest.fn(async () => true)
  return { useSessionArchiveActions: () => ({ archive, unarchive }), __unarchive: unarchive }
})

import { ArchivedConversationBanner } from "./archived-conversation-banner"

const { __unarchive: unarchiveMock } = jest.requireMock(
  "@/hooks/chat/use-session-archive-actions"
) as { __unarchive: jest.Mock }

const ARCHIVED_AT = Date.UTC(2026, 8, 30, 12, 0, 0)

function row(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "Quarterly plan",
    kind: "direct",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as ChatSession
}

beforeEach(() => {
  unarchiveMock.mockReset().mockResolvedValue(true)
})

describe("ArchivedConversationBanner", () => {
  it("renders nothing for an active conversation", () => {
    const { container } = render(<ArchivedConversationBanner session={row()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says the conversation is archived, since when, and that a send restores it", () => {
    render(<ArchivedConversationBanner session={row({ archivedAt: ARCHIVED_AT })} />)
    const banner = screen.getByTestId("archived-conversation-banner")
    expect(banner).toHaveAttribute("role", "status")
    expect(banner).toHaveTextContent("This conversation is archived")
    expect(banner).toHaveTextContent(`Archived ${new Date(ARCHIVED_AT).toISOString()}.`)
    expect(banner).toHaveTextContent("Sending a message moves it back to your conversations.")
    expect(screen.queryByTestId("archived-conversation-locked")).not.toBeInTheDocument()
  })

  it("unarchives this conversation and holds the button while the write runs", async () => {
    let settle: (landed: boolean) => void = () => {}
    unarchiveMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const session = row({ archivedAt: ARCHIVED_AT })
    render(<ArchivedConversationBanner session={session} />)
    const button = screen.getByRole("button", { name: "Unarchive" })
    fireEvent.click(button)
    expect(unarchiveMock).toHaveBeenCalledWith([session])
    expect(button).toBeDisabled()
    settle(false)
    await waitFor(() => expect(button).toBeEnabled())
  })

  it("offers no restore while the conversation is handed off to another device", () => {
    render(
      <ArchivedConversationBanner
        session={row({
          archivedAt: ARCHIVED_AT,
          handoffLock: { ticketId: "t1" } as ChatSession["handoffLock"],
        })}
      />
    )
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeDisabled()
    expect(screen.getByTestId("archived-conversation-locked")).toHaveTextContent(
      "This conversation is read-only while it is handed off to another device."
    )
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }))
    expect(unarchiveMock).not.toHaveBeenCalled()
  })

  it("passes its class name to the alert", () => {
    render(
      <ArchivedConversationBanner session={row({ archivedAt: ARCHIVED_AT })} className="mt-9" />
    )
    expect(screen.getByTestId("archived-conversation-banner")).toHaveClass("mt-9")
  })
})
