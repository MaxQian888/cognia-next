/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("./triage-preview-pane", () => ({
  TriagePreviewPane: ({
    sessionId,
    layout,
    onOpenInChat,
    onClose,
  }: {
    sessionId: string
    layout?: string
    onOpenInChat: (conversation: unknown) => void
    onClose?: () => void
  }) => (
    <div
      data-testid="pane"
      data-session={sessionId}
      data-layout={layout}
      data-closable={String(Boolean(onClose))}
    >
      <button
        type="button"
        onClick={() => onOpenInChat({ conversationKey: "from-pane", session: { id: sessionId } })}
      >
        pane-reply
      </button>
    </div>
  ),
}))

import { TriagePreviewDrawer } from "./triage-preview-drawer"

const TARGET = { sessionId: "s1", conversationKey: "tg:a1:c1", title: "Acme" }

describe("TriagePreviewDrawer", () => {
  it("hosts the pane stacked, without its own close button", () => {
    render(<TriagePreviewDrawer target={TARGET} onClose={jest.fn()} onOpenInChat={jest.fn()} />)
    const pane = screen.getByTestId("pane")
    expect(pane).toHaveAttribute("data-session", "s1")
    expect(pane).toHaveAttribute("data-layout", "stacked")
    expect(pane).toHaveAttribute("data-closable", "false")
    expect(screen.getByText("Preview: Acme")).toBeInTheDocument()
  })

  it("replies in chat from the sticky bottom button and from the pane", () => {
    const onOpenInChat = jest.fn()
    render(<TriagePreviewDrawer target={TARGET} onClose={jest.fn()} onOpenInChat={onOpenInChat} />)
    const reply = screen.getByTestId("triage-drawer-reply")
    expect(reply).toHaveTextContent("Reply in chat")
    // Clear of the home indicator.
    expect(reply.parentElement?.className).toContain("env(safe-area-inset-bottom)")
    fireEvent.click(reply)
    expect(onOpenInChat).toHaveBeenCalledWith("tg:a1:c1", "s1")
    fireEvent.click(screen.getByText("pane-reply"))
    expect(onOpenInChat).toHaveBeenLastCalledWith("from-pane", "s1")
  })

  it("is closed without a target and reports dismissal", async () => {
    const onClose = jest.fn()
    const { rerender } = render(
      <TriagePreviewDrawer target={null} onClose={onClose} onOpenInChat={jest.fn()} />
    )
    expect(screen.queryByTestId("triage-preview-drawer")).not.toBeInTheDocument()
    rerender(<TriagePreviewDrawer target={TARGET} onClose={onClose} onOpenInChat={jest.fn()} />)
    fireEvent.keyDown(screen.getByTestId("triage-preview-drawer"), { key: "Escape" })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
