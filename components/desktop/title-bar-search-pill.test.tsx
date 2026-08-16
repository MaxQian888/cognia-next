/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

const chatRef = { status: "idle" as "idle" | "streaming" | "awaiting_approval" | "error" }
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ status: chatRef.status }),
}))

const labelRef = { value: undefined as string | undefined }
jest.mock("@/hooks/chat/use-active-session-label", () => ({
  useActiveSessionLabel: () => ({ label: labelRef.value }),
}))

import { TitleBarSearchPill } from "./title-bar-search-pill"

const onClick = jest.fn()

const renderPill = () =>
  render(
    <TitleBarSearchPill
      appName="Cognia"
      separator=" — "
      placeholder="Search or jump to…"
      kbdHint="⌘K"
      onClick={onClick}
    />
  )

beforeEach(() => {
  onClick.mockClear()
  chatRef.status = "idle"
  labelRef.value = undefined
})

describe("TitleBarSearchPill", () => {
  it("shows the app name alone when no conversation is active", () => {
    renderPill()
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("Cognia")
  })

  it("appends the active conversation label", () => {
    labelRef.value = "Refactor the parser"
    renderPill()
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("Cognia — Refactor the parser")
  })

  it("swaps the magnifier for a pulsing dot while streaming", () => {
    chatRef.status = "streaming"
    renderPill()
    expect(screen.getByTestId("title-bar-streaming-dot")).toBeInTheDocument()
  })

  it("shows no streaming dot when idle", () => {
    renderPill()
    expect(screen.queryByTestId("title-bar-streaming-dot")).toBeNull()
  })

  it("opens the command palette on click and labels itself with the placeholder", () => {
    renderPill()
    const pill = screen.getByRole("button", { name: "Search or jump to…" })
    fireEvent.click(pill)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders the keyboard hint", () => {
    renderPill()
    expect(screen.getByText("⌘K")).toBeInTheDocument()
  })
})

describe("TitleBarSearchPill — compact", () => {
  it("drops the label but keeps the icon, the shortcut and the full accessible name", () => {
    labelRef.value = "Refactor the parser"
    render(
      <TitleBarSearchPill
        appName="Cognia"
        separator=" — "
        placeholder="Search or jump to…"
        kbdHint="⌘K"
        compact
        onClick={onClick}
      />
    )
    const pill = screen.getByTestId("title-bar-search-pill")
    expect(pill).toHaveAttribute("data-compact", "true")
    expect(screen.queryByTestId("title-bar-title")).toBeNull()
    expect(pill).toHaveTextContent("⌘K")
    // The words are still there for AT and on hover — only the pixels went.
    expect(pill).toHaveAccessibleName("Search or jump to… — Cognia — Refactor the parser")
    expect(pill).toHaveAttribute("title", "Cognia — Refactor the parser")
    fireEvent.click(pill)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
