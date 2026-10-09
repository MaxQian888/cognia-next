/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/tooltip")
jest.mock("../thread-membership-chip", () => ({
  ThreadMembershipChip: () => <span data-testid="thread-chip" />,
}))

import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import { TriagePreviewHeader } from "./triage-preview-header"

function conversation(over: Partial<TriageConversation> = {}): TriageConversation {
  return {
    session: { id: "s1", title: "Acme support" } as TriageConversation["session"],
    conversationKey: "lark:a1:oc_1",
    adapterId: "a1",
    platform: "lark",
    override: undefined,
    adapter: { id: "a1", displayName: "Support bot" } as TriageConversation["adapter"],
    policy: undefined,
    unreadCount: 0,
    ...over,
  }
}

describe("TriagePreviewHeader", () => {
  it("names the conversation and where it came from", () => {
    render(
      <TriagePreviewHeader
        conversation={conversation()}
        onOpenInChat={() => {}}
        onOpenContact={() => {}}
      />
    )
    expect(screen.getByRole("heading", { name: "Acme support" })).toBeInTheDocument()
    expect(screen.getByText("Support bot · Lark")).toBeInTheDocument()
    expect(screen.getByTestId("thread-chip")).toBeInTheDocument()
  })

  it("falls back to the key and adapter id when names are missing", () => {
    render(
      <TriagePreviewHeader
        conversation={conversation({
          session: { id: "s1", title: "" } as TriageConversation["session"],
          adapter: undefined,
        })}
        onOpenInChat={() => {}}
        onOpenContact={() => {}}
      />
    )
    expect(screen.getByRole("heading", { name: "lark:a1:oc_1" })).toBeInTheDocument()
    expect(screen.getByText("a1 · Lark")).toBeInTheDocument()
  })

  it("offers Reply in chat as the primary action, plus contact and close", () => {
    const onOpenInChat = jest.fn()
    const onOpenContact = jest.fn()
    const onClose = jest.fn()
    render(
      <TriagePreviewHeader
        conversation={conversation()}
        onOpenInChat={onOpenInChat}
        onOpenContact={onOpenContact}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Reply in chat" }))
    fireEvent.click(screen.getByRole("button", { name: "Contact profile" }))
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
    expect(onOpenInChat).toHaveBeenCalledTimes(1)
    expect(onOpenContact).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("omits close when the host owns dismissal", () => {
    render(
      <TriagePreviewHeader
        conversation={conversation()}
        onOpenInChat={() => {}}
        onOpenContact={() => {}}
      />
    )
    expect(screen.queryByRole("button", { name: "Close preview" })).not.toBeInTheDocument()
  })
})
