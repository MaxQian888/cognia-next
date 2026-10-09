import { fireEvent, render, screen } from "@testing-library/react"

import { buildSessionHref } from "@/lib/chat/message-permalink"

import { GoalConversationLink, goalConversationHref } from "./goal-conversation-link"

// next-intl globally mocked against en.json in jest.setup.ts.

describe("goalConversationHref", () => {
  it("opens the conversation at the chat root via buildSessionHref", () => {
    expect(goalConversationHref("ses_1")).toBe(`/${buildSessionHref("ses_1")}`)
    expect(goalConversationHref("ses_1")).toBe("/?session=ses_1")
  })
})

describe("GoalConversationLink", () => {
  it("says Loading… while the session read is in flight, still linking", () => {
    render(<GoalConversationLink sessionId="ses_1" session={undefined} />)
    const link = screen.getByRole("link", { name: "Open conversation “Loading…”" })
    expect(link).toHaveAttribute("href", "/?session=ses_1")
    expect(link).toHaveTextContent("Loading…")
  })

  it("links to the conversation by its title", () => {
    render(
      <GoalConversationLink sessionId="ses_1" session={{ id: "ses_1", title: "Refactor auth" }} />
    )
    const link = screen.getByRole("link", { name: "Open conversation “Refactor auth”" })
    expect(link).toHaveAttribute("href", "/?session=ses_1")
    expect(link).toHaveTextContent("Refactor auth")
  })

  it("prints an untitled or placeholder conversation the way the session list does", () => {
    const { rerender } = render(
      <GoalConversationLink sessionId="ses_1" session={{ id: "ses_1", title: "" }} />
    )
    expect(screen.getByRole("link")).toHaveTextContent("(untitled)")
    rerender(<GoalConversationLink sessionId="ses_1" session={{ id: "ses_1", title: "新对话" }} />)
    expect(screen.getByRole("link")).toHaveTextContent("New chat")
  })

  it("reads as deleted, without a link, once the session is known to be gone", () => {
    render(<GoalConversationLink sessionId="ses_1" session={null} />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByTestId("goal-conversation-missing")).toHaveTextContent(
      "Conversation deleted"
    )
  })

  it("does not let the click select the row around it", () => {
    const onRowClick = jest.fn()
    render(
      <div onClick={onRowClick}>
        <GoalConversationLink sessionId="ses_1" session={{ id: "ses_1", title: "T" }} />
      </div>
    )
    fireEvent.click(screen.getByRole("link"))
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
