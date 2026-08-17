/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import en from "@/i18n/messages/en.json"
import { listConnectorMetadata } from "@/lib/connectors/adapter-metadata"
import { PLATFORM_BADGE_ABBR_KINDS, PlatformBadge, fallbackPlatformAbbr } from "./platform-badge"

const ABBR = (en as { inbox: { platformBadge: { abbr: Record<string, string> } } }).inbox
  .platformBadge.abbr
const PLANNED_KINDS = listConnectorMetadata()
  .filter((m) => m.status === "planned")
  .map((m) => m.type)

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

  it("resolves every buildable kind's abbreviation from i18n (no hard-coded literal)", () => {
    expect(PLATFORM_BADGE_ABBR_KINDS).toHaveLength(11)
    for (const kind of PLATFORM_BADGE_ABBR_KINDS) {
      expect(ABBR[kind]).toBeTruthy()
      const { unmount } = render(<PlatformBadge platform={kind} />)
      const badge = screen.getByTestId(`platform-badge-${kind}`)
      expect(badge).toHaveTextContent(ABBR[kind]!)
      expect(badge).toHaveAttribute("title", kind)
      expect(badge).not.toHaveAttribute("data-planned")
      unmount()
    }
  })

  // Dormancy pin (axis 3 of 3): `ConnectorMeta.status === "planned"` kinds
  // must render through the generic fallback — no bespoke literal, no colour,
  // and the "Planned platform" title — until they get a real adapter.
  it("renders planned kinds through the generic fallback, labelled as planned", () => {
    expect(PLANNED_KINDS).toEqual(["email", "kook", "line", "mattermost"])
    for (const kind of PLANNED_KINDS) {
      // No abbreviation may exist for a planned kind — adding one is the
      // signal that the platform became buildable and this pin must move.
      expect(ABBR[kind]).toBeUndefined()
      expect(PLATFORM_BADGE_ABBR_KINDS).not.toContain(kind)
      const { unmount } = render(<PlatformBadge platform={kind} />)
      const badge = screen.getByTestId(`platform-badge-${kind}`)
      expect(badge).toHaveTextContent(fallbackPlatformAbbr(kind))
      expect(badge).toHaveTextContent(kind.slice(0, 2).toUpperCase())
      expect(badge).toHaveClass("text-muted-foreground")
      expect(badge).toHaveAttribute("title", "Planned platform")
      expect(badge).toHaveAttribute("data-planned", "true")
      unmount()
    }
  })

  it("renders all 15 built-in platform kinds without crashing", () => {
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
      "wechat-personal",
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
