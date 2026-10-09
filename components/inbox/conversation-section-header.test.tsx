/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/tooltip")
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { ConversationSectionHeader } from "./conversation-section-header"

function renderHeader(props: Partial<React.ComponentProps<typeof ConversationSectionHeader>> = {}) {
  const onToggle = jest.fn()
  render(
    <ConversationSectionHeader
      sectionId="adapter:a1"
      label="Support bot"
      count={4}
      collapsed={false}
      onToggle={onToggle}
      controlsId="section-list-adapter-a1"
      {...props}
    />
  )
  return { onToggle }
}

describe("ConversationSectionHeader", () => {
  it("is a sticky band with the label and count", () => {
    renderHeader()
    const header = screen.getByTestId("conversation-section-header-adapter:a1")
    expect(header).toHaveClass("sticky", "top-0")
    expect(header).toHaveTextContent("Support bot")
    expect(screen.getByTestId("conversation-section-count-adapter:a1")).toHaveTextContent("4")
  })

  it("is a labelled disclosure pointing at its list", () => {
    const { onToggle } = renderHeader()
    const toggle = screen.getByRole("button", { name: "Collapse Support bot (4)" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveAttribute("aria-controls", "section-list-adapter-a1")
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("reads as expandable while collapsed", () => {
    renderHeader({ collapsed: true })
    expect(screen.getByRole("button", { name: "Expand Support bot (4)" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("shows an unread count only when non-zero", () => {
    renderHeader({ unreadCount: 0 })
    expect(screen.queryByTestId("conversation-section-unread-adapter:a1")).not.toBeInTheDocument()
  })

  it("shows the unread count when there is one", () => {
    renderHeader({ unreadCount: 2 })
    expect(screen.getByTestId("conversation-section-unread-adapter:a1")).toHaveTextContent(
      "2 unread"
    )
  })

  it("links to the scoped route when given one", () => {
    renderHeader({ scopeHref: "/inbox/adapter?adapterId=a1" })
    const link = screen.getByRole("link", { name: "Open Support bot on its own" })
    expect(link).toHaveAttribute("href", "/inbox/adapter?adapterId=a1")
  })

  it("has no scope link without a scope", () => {
    renderHeader()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
})
