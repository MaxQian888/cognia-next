/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PlatformBadge } from "./platform-badge"

describe("PlatformBadge", () => {
  it("renders a badge with the correct test id for telegram", () => {
    render(<PlatformBadge platform="telegram" />)
    expect(screen.getByTestId("platform-badge-telegram")).toBeInTheDocument()
  })

  it("renders a badge with the correct test id for discord", () => {
    render(<PlatformBadge platform="discord" />)
    expect(screen.getByTestId("platform-badge-discord")).toBeInTheDocument()
  })

  it("renders the label abbreviation by default", () => {
    render(<PlatformBadge platform="slack" />)
    const badge = screen.getByTestId("platform-badge-slack")
    expect(badge).toHaveTextContent("SL")
  })

  it("hides the label when iconOnly=true", () => {
    render(<PlatformBadge platform="slack" iconOnly />)
    const badge = screen.getByTestId("platform-badge-slack")
    expect(badge).not.toHaveTextContent("SL")
  })

  it("renders title attribute matching the platform kind", () => {
    render(<PlatformBadge platform="lark" />)
    expect(screen.getByTitle("lark")).toBeInTheDocument()
  })

  it("uses the shadcn Badge primitive (ghost variant)", () => {
    render(<PlatformBadge platform="telegram" />)
    const badge = screen.getByTestId("platform-badge-telegram")
    expect(badge).toHaveAttribute("data-slot", "badge")
    expect(badge).toHaveAttribute("data-variant", "ghost")
  })

  it("applies the platform colour class", () => {
    render(<PlatformBadge platform="telegram" />)
    expect(screen.getByTestId("platform-badge-telegram")).toHaveClass("text-sky-500")
  })

  it("merges a user-supplied className", () => {
    render(<PlatformBadge platform="telegram" className="extra-class" />)
    expect(screen.getByTestId("platform-badge-telegram")).toHaveClass("extra-class")
  })

  it("reuses the generic badge and icon fallback for a plugin-owned platform id", () => {
    render(<PlatformBadge platform="acme-chat" />)
    const badge = screen.getByTestId("platform-badge-acme-chat")
    expect(badge).toHaveTextContent("AC")
    expect(badge).toHaveClass("text-muted-foreground")
    expect(badge.querySelector("svg")).not.toBeNull()
  })

  it("renders all 14 platform kinds without crashing", () => {
    const PLATFORMS = [
      "telegram",
      "discord",
      "slack",
      "lark",
      "onebot",
      "dingtalk",
      "wecom",
      "wechat-oa",
      "qq-official",
      "email",
      "matrix",
      "kook",
      "line",
      "mattermost",
    ] as const

    PLATFORMS.forEach((p) => {
      const { unmount } = render(<PlatformBadge platform={p} />)
      expect(screen.getByTestId(`platform-badge-${p}`)).toBeInTheDocument()
      unmount()
    })
  })
})
