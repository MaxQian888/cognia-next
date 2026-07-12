/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MobileTabBar, pickActiveTabId } from "./mobile-tab-bar"

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
  it("matches discover for /agent-teams", () => {
    expect(pickActiveTabId("/agent-teams/x")).toBe("discover")
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
})
