/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { MobileShellWrapper } from "./mobile-shell-wrapper"

const platformMock = jest.fn(() => "mobile")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformMock(),
}))

const pathnameMock = jest.fn(() => "/")
jest.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}))

jest.mock("next/link", () => {
  const Link = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: jest.fn(async () => ({ kind: "ok" })),
}))

jest.mock("@/components/mobile/offline-banner", () => ({
  OfflineBanner: () => null,
}))

const inboundUnreadRef = { value: 0 }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => inboundUnreadRef.value,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    inboundLedger: {
      where: () => ({ above: () => ({ count: () => Promise.resolve(0) }) }),
    },
  }),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: { settings: { lastInboxViewedAt: number } | null }) => unknown
  ) => selector({ settings: { lastInboxViewedAt: 0 } }),
}))

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, vars?: Record<string, unknown>) => {
    if (ns === "mobile.tabs") {
      return { chat: "聊天", workflows: "工作流", discover: "发现", me: "我" }[key] ?? key
    }
    if (ns === "mobile.tabBar" && key === "unread") {
      return `${vars?.count ?? 0} unread`
    }
    return key
  },
}))

describe("<MobileShellWrapper />", () => {
  beforeEach(() => {
    platformMock.mockReset().mockReturnValue("mobile")
    pathnameMock.mockReset().mockReturnValue("/")
    inboundUnreadRef.value = 0
  })

  it("renders the tab bar on mobile", () => {
    render(
      <MobileShellWrapper>
        <div>child</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-tab-bar")).toBeInTheDocument()
    expect(screen.getByText("child")).toBeInTheDocument()
  })

  it("hides the tab bar on /pair", () => {
    pathnameMock.mockReturnValue("/pair")
    render(
      <MobileShellWrapper>
        <div>pair page</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("hides the tab bar on /oauth/*", () => {
    pathnameMock.mockReturnValue("/oauth/callback")
    render(
      <MobileShellWrapper>
        <div>oauth</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("does not render tab bar on tauri", () => {
    platformMock.mockReturnValue("tauri")
    render(
      <MobileShellWrapper>
        <div>desktop</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("does not render tab bar on web", () => {
    platformMock.mockReturnValue("web")
    render(
      <MobileShellWrapper>
        <div>web</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("forwards badges to the tab bar", () => {
    render(
      <MobileShellWrapper badges={{ chat: 3 }}>
        <div>child</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-tab-badge-chat")).toHaveTextContent("3")
  })

  it("merges inbound unread into the chat badge", () => {
    inboundUnreadRef.value = 7
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-tab-badge-chat")).toHaveTextContent("7")
  })

  it("sets data-tab-bar-visible attribute correctly", () => {
    pathnameMock.mockReturnValue("/")
    const { rerender } = render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute(
      "data-tab-bar-visible",
      "true"
    )
    pathnameMock.mockReturnValue("/pair")
    rerender(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute(
      "data-tab-bar-visible",
      "false"
    )
  })
})
