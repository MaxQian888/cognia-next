/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

import { ConversationJumpPill, resolveJumpPillMode } from "./conversation-jump-pill"
import { useSettingsStore } from "@/stores/settings/settings-store"

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as never })
})

describe("resolveJumpPillMode", () => {
  it("offers nothing when parked at the bottom with no history", () => {
    expect(resolveJumpPillMode({ atBottom: true, canReturn: false, newMessageCount: 0 })).toBeNull()
  })

  it("offers the way back down when scrolled up", () => {
    expect(resolveJumpPillMode({ atBottom: false, canReturn: false, newMessageCount: 0 })).toBe(
      "toBottom"
    )
  })

  it("prefers the unread count over a bare jump-to-latest", () => {
    // Both point at the same place; the count is strictly more informative.
    expect(resolveJumpPillMode({ atBottom: false, canReturn: false, newMessageCount: 3 })).toBe(
      "newMessages"
    )
  })

  it("puts the return offer ahead of both", () => {
    // It is the only offer that expires, and it answers something the user
    // deliberately asked for seconds ago. The others stay available regardless.
    expect(resolveJumpPillMode({ atBottom: false, canReturn: true, newMessageCount: 9 })).toBe(
      "return"
    )
  })

  it("still offers the return even at the bottom", () => {
    // Jumping to the newest turn and then wanting to undo it is ordinary; this
    // is the one case where "at the bottom" does not mean "nothing to offer".
    expect(resolveJumpPillMode({ atBottom: true, canReturn: true, newMessageCount: 0 })).toBe(
      "return"
    )
  })
})

describe("ConversationJumpPill", () => {
  const handlers = () => ({ onReturn: jest.fn(), onToBottom: jest.fn() })

  it("renders nothing actionable when there is no offer", () => {
    render(<ConversationJumpPill mode={null} {...handlers()} />)
    expect(screen.queryByTestId("conversation-jump-pill")).not.toBeInTheDocument()
  })

  it("names itself for assistive tech in every mode", () => {
    // It was an icon-only button with no accessible name and no string in
    // either locale.
    const { rerender } = render(<ConversationJumpPill mode="toBottom" {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute("aria-label", "toBottom")

    rerender(<ConversationJumpPill mode="return" {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute("aria-label", "back")

    rerender(<ConversationJumpPill mode="newMessages" newMessageCount={4} {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute(
      "aria-label",
      "newMessages:4"
    )
  })

  it("routes the click to the action the current mode promises", () => {
    const h = handlers()
    const { rerender } = render(<ConversationJumpPill mode="return" {...h} />)
    fireEvent.click(screen.getByTestId("conversation-jump-pill"))
    expect(h.onReturn).toHaveBeenCalledTimes(1)
    expect(h.onToBottom).not.toHaveBeenCalled()

    rerender(<ConversationJumpPill mode="toBottom" {...h} />)
    fireEvent.click(screen.getByTestId("conversation-jump-pill"))
    expect(h.onToBottom).toHaveBeenCalledTimes(1)

    rerender(<ConversationJumpPill mode="newMessages" newMessageCount={2} {...h} />)
    fireEvent.click(screen.getByTestId("conversation-jump-pill"))
    // "N new messages" is still a trip to the bottom, just a better-labelled one.
    expect(h.onToBottom).toHaveBeenCalledTimes(2)
  })

  it("announces only the arriving-messages count", () => {
    // That is the one thing that changes while the pill is already on screen;
    // announcing the other modes would narrate the user's own scrolling back
    // at them.
    const { rerender } = render(
      <ConversationJumpPill mode="newMessages" newMessageCount={2} {...handlers()} />
    )
    expect(screen.getByTestId("conversation-jump-pill-live")).toHaveTextContent("newMessages:2")

    rerender(<ConversationJumpPill mode="toBottom" {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill-live")).toHaveTextContent("")
  })

  it("exposes the mode so the swap is keyed rather than a silent relabel", () => {
    const { rerender } = render(<ConversationJumpPill mode="toBottom" {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute("data-mode", "toBottom")
    rerender(<ConversationJumpPill mode="return" {...handlers()} />)
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute("data-mode", "return")
  })

  it("keeps the shell inert so it never eats clicks on the message below", () => {
    const { container } = render(<ConversationJumpPill mode="toBottom" {...handlers()} />)
    const shell = container.firstElementChild as HTMLElement
    expect(shell.className).toContain("pointer-events-none")
    expect(screen.getByTestId("conversation-jump-pill").className).toContain("pointer-events-auto")
  })

  it("still renders the offer when motion is reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const h = handlers()
    render(<ConversationJumpPill mode="return" {...h} />)
    fireEvent.click(screen.getByTestId("conversation-jump-pill"))
    expect(h.onReturn).toHaveBeenCalledTimes(1)
  })

  it("renders nothing actionable with no offer and reduced motion", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    render(<ConversationJumpPill mode={null} {...handlers()} />)
    expect(screen.queryByTestId("conversation-jump-pill")).not.toBeInTheDocument()
  })
})
