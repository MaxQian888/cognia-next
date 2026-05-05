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
