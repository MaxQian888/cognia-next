/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MobileTabBar, pickActiveTabId } from "./mobile-tab-bar"
import { ME_ENTRIES } from "@/components/mobile/me/me-entries"

const pathnameMock = jest.fn(() => "/")
jest.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}))
jest.mock("next/link", () => {
  const Link = ({
    children,
    href,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    href: string
    onClick?: () => void
  } & Record<string, unknown>) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

const selectionFeedbackMock = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: () => selectionFeedbackMock(),
}))

describe("pickActiveTabId", () => {
  it("matches chat for /", () => {
    expect(pickActiveTabId("/")).toBe("chat")
  })
  it("matches chat for /inbox", () => {
    expect(pickActiveTabId("/inbox")).toBe("chat")
    expect(pickActiveTabId("/inbox/c/123")).toBe("chat")
  })
  it("matches workflows for /workflows/abc", () => {
    expect(pickActiveTabId("/workflows/abc/runs")).toBe("workflows")
  })
  it("matches discover for /squads", () => {
    expect(pickActiveTabId("/squads")).toBe("discover")
  })
  // `/templates` had a full phone body and no tab-bar prefix, so opening it
  // left the bar highlighting Chat — the shape a user reads as "I am lost".
  it("matches discover for /templates", () => {
    expect(pickActiveTabId("/templates")).toBe("discover")
  })
  it("matches me for /settings/foo (longest prefix wins over /)", () => {
    expect(pickActiveTabId("/settings/connections")).toBe("me")
  })
  it("matches me for /pair", () => {
    expect(pickActiveTabId("/pair")).toBe("me")
  })
  it("falls back to chat for unknown routes", () => {
    expect(pickActiveTabId("/something-else")).toBe("chat")
  })
  // Every screen the `/me` hub opens must light a tab that leads back to it.
  // Falling through to Chat is what made Memory and Projects read as "lost".
  it("never lights Chat for a screen the Me hub opens", () => {
    for (const entry of ME_ENTRIES) {
      const tab = pickActiveTabId(entry.href)
      expect({ href: entry.href, tab }).not.toEqual({ href: entry.href, tab: "chat" })
    }
  })
  it("matches me for the hub's out-of-/me destinations", () => {
    expect(pickActiveTabId("/memory")).toBe("me")
    expect(pickActiveTabId("/projects")).toBe("me")
    expect(pickActiveTabId("/search")).toBe("me")
  })
})

describe("<MobileTabBar />", () => {
  beforeEach(() => {
    pathnameMock.mockReset().mockReturnValue("/")
    selectionFeedbackMock.mockReset().mockResolvedValue({ kind: "ok" })
  })

  it("renders four tabs", () => {
    render(<MobileTabBar />)
    expect(screen.getByTestId("mobile-tab-chat")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-tab-workflows")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-tab-discover")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-tab-me")).toBeInTheDocument()
  })

  it("marks the matching tab aria-selected=true", () => {
    pathnameMock.mockReturnValue("/workflows/abc")
    render(<MobileTabBar />)
    expect(screen.getByTestId("mobile-tab-workflows")).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("mobile-tab-chat")).toHaveAttribute("aria-selected", "false")
  })

  it("renders a badge when count > 0", () => {
    render(<MobileTabBar badges={{ chat: 7 }} />)
    expect(screen.getByTestId("mobile-tab-badge-chat")).toHaveTextContent("7")
  })

  it("clamps badge counts above 99 to '99+'", () => {
    render(<MobileTabBar badges={{ chat: 245 }} />)
    expect(screen.getByTestId("mobile-tab-badge-chat")).toHaveTextContent("99+")
  })

  it("truncates tab labels so long-locale text can't overflow the cell", () => {
    render(<MobileTabBar />)
    const label = screen.getByTestId("mobile-tab-chat").querySelector(".truncate")
    expect(label).toBeTruthy()
    expect(label).toHaveClass("max-w-full")
  })

  it("triggers haptic selectionFeedback on tap", async () => {
    const user = userEvent.setup()
    render(<MobileTabBar />)
    await user.click(screen.getByTestId("mobile-tab-discover"))
    expect(selectionFeedbackMock).toHaveBeenCalled()
  })

  it("slides off-screen and blocks pointer events when keyboardHidden", () => {
    render(<MobileTabBar keyboardHidden />)
    const bar = screen.getByTestId("mobile-tab-bar")
    expect(bar).toHaveAttribute("data-keyboard-hidden", "true")
    expect(bar).toHaveAttribute("aria-hidden", "true")
    expect(bar.className).toContain("translate-y-full")
    expect(bar.className).toContain("pointer-events-none")
  })

  it("stays interactive when keyboardHidden is false (default)", () => {
    render(<MobileTabBar />)
    const bar = screen.getByTestId("mobile-tab-bar")
    expect(bar).toHaveAttribute("data-keyboard-hidden", "false")
    expect(bar).not.toHaveAttribute("aria-hidden")
    expect(bar.className).not.toContain("translate-y-full")
  })

  /**
   * The bar is `56px + env(safe-area-inset-bottom)` tall, with the inset as
   * padding inside that box.
   *
   * `h-14` beside `safe-area-pb` said the opposite under `box-sizing:
   * border-box`: the inset came OUT of the 56px, so on a phone with a gesture
   * bar the icon column compressed and the labels sat in the system zone. It
   * also broke the contract with the callers, which all reserve
   * `calc(theme(spacing.14) + env(safe-area-inset-bottom))` above the bar and
   * were therefore over-reserving by exactly the inset, showing as a strip of
   * bare background between the page and the bar.
   */
  it("is 56px tall PLUS the safe-area inset, matching the reserve its callers make", () => {
    render(<MobileTabBar />)
    const bar = screen.getByTestId("mobile-tab-bar")
    const height = "h-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]"
    expect(bar.className).toContain(height)
    expect(bar.className).toContain(`min-${height}`)
    expect(bar.className).toContain("safe-area-pb")
    // The old shape. `h-14` would make the inset eat the row instead of adding
    // to it, so it must not come back alongside the padding.
    expect(bar.className).not.toMatch(/(^|\s)h-14(\s|$)/)
    expect(bar.className).not.toMatch(/(^|\s)min-h-14(\s|$)/)
  })
})

describe("<MobileTabBar /> — active indicator", () => {
  it("mounts exactly one indicator, inside the active tab", () => {
    // One instance is the whole point: `layoutId` can only slide a shared
    // element between stops if there is a single one to slide.
    pathnameMock.mockReturnValue("/workflows")
    render(<MobileTabBar />)
    const indicators = screen.getAllByTestId("mobile-tab-indicator")
    expect(indicators).toHaveLength(1)
    expect(screen.getByTestId("mobile-tab-workflows")).toContainElement(indicators[0])
  })

  it("moves the indicator when the active route changes", () => {
    pathnameMock.mockReturnValue("/")
    const { rerender } = render(<MobileTabBar />)
    expect(screen.getByTestId("mobile-tab-chat")).toContainElement(
      screen.getByTestId("mobile-tab-indicator")
    )

    pathnameMock.mockReturnValue("/me")
    rerender(<MobileTabBar />)
    expect(screen.getByTestId("mobile-tab-me")).toContainElement(
      screen.getByTestId("mobile-tab-indicator")
    )
    expect(screen.getAllByTestId("mobile-tab-indicator")).toHaveLength(1)
  })

  it("keeps the indicator decorative (the aria-selected state carries the meaning)", () => {
    pathnameMock.mockReturnValue("/")
    render(<MobileTabBar />)
    expect(screen.getByTestId("mobile-tab-indicator")).toHaveAttribute("aria-hidden", "true")
  })
})
