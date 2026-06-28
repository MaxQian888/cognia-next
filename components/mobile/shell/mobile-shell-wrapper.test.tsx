/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { MobileShellWrapper } from "./mobile-shell-wrapper"
import { useSettingsStore as realSettingsStore } from "@/stores/settings/settings-store"
import type { MobileTabLayout } from "@/types/shell/mobile-tabs"

const platformMock = jest.fn(() => "mobile")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformMock(),
}))

const pathnameMock = jest.fn(() => "/")
const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ replace: replaceMock }),
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
  OfflineBanner: () => <div data-testid="offline-banner-stub" />,
}))

jest.mock("@/components/mobile/mobile-outbound-runner-provider", () => ({
  MobileOutboundRunnerProvider: () => <div data-testid="outbound-runner-stub" />,
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
    replaceMock.mockReset()
    // The tab bar + landing redirect read the real settings-store (the
    // `@/stores/settings` mock above only covers the wrapper's own selector).
    realSettingsStore.setState({ settings: null } as never)
  })

  function setTabLayout(layout: MobileTabLayout) {
    realSettingsStore.setState({ settings: { mobileTabLayout: layout } } as never)
  }

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

  it("hides the tab bar on a workflow detail sub-route (full-screen editor)", () => {
    pathnameMock.mockReturnValue("/workflows/wf-123")
    render(
      <MobileShellWrapper>
        <div>editor</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("keeps the tab bar on the /workflows list", () => {
    pathnameMock.mockReturnValue("/workflows")
    render(
      <MobileShellWrapper>
        <div>list</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-tab-bar")).toBeInTheDocument()
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

  it("desktop pass-through: omits OfflineBanner and outbound runner on tauri", () => {
    platformMock.mockReturnValue("tauri")
    render(
      <MobileShellWrapper>
        <div data-testid="child">desktop</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("child")).toBeInTheDocument()
    expect(screen.queryByTestId("offline-banner-stub")).not.toBeInTheDocument()
    expect(screen.queryByTestId("outbound-runner-stub")).not.toBeInTheDocument()
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
  })

  it("desktop pass-through: omits OfflineBanner and outbound runner on web", () => {
    platformMock.mockReturnValue("web")
    render(
      <MobileShellWrapper>
        <div data-testid="child">web</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("offline-banner-stub")).not.toBeInTheDocument()
    expect(screen.queryByTestId("outbound-runner-stub")).not.toBeInTheDocument()
  })

  it("mobile: mounts OfflineBanner and outbound runner", () => {
    platformMock.mockReturnValue("mobile")
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("offline-banner-stub")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-runner-stub")).toBeInTheDocument()
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

  it("redirects to the configured landing tab on launch", () => {
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).toHaveBeenCalledWith("/workflows")
  })

  it("does not redirect when the landing tab is chat (default)", () => {
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("does not redirect when launched on a non-root path", () => {
    pathnameMock.mockReturnValue("/discover")
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("does not redirect on desktop platforms", () => {
    platformMock.mockReturnValue("web")
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("gives workflow detail sub-routes a definite full-viewport height", () => {
    pathnameMock.mockReturnValue("/workflows/editor")
    const { container } = render(
      <MobileShellWrapper>
        <div>editor</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute("data-full-viewport", "true")
    // The inner body container is the definite-height flex column the ReactFlow
    // canvas needs — a bare min-h-[100dvh] collapses the canvas to 0.
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).toContain("h-[100dvh]")
    expect(inner?.className).not.toContain("min-h-[100dvh]")
  })

  it("gives the A2UI mini-apps route a definite full-viewport height while keeping the tab bar", () => {
    pathnameMock.mockReturnValue("/a2ui")
    const { container } = render(
      <MobileShellWrapper>
        <div>a2ui hub</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute("data-full-viewport", "true")
    // The hub wraps its body in a ScrollArea h-full + the workspace stacks a
    // flex-1 region — both need the definite-height column, not min-h-[100dvh].
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).toContain("h-[100dvh]")
    expect(inner?.className).not.toContain("min-h-[100dvh]")
    // Unlike the workflow editor, the A2UI hub is a top-level destination, so
    // the tab bar stays mounted (content is padded above it).
    expect(screen.getByTestId("mobile-tab-bar")).toBeInTheDocument()
  })

  it("keeps the document-scroll min-height on the /workflows list (not full-viewport)", () => {
    pathnameMock.mockReturnValue("/workflows")
    const { container } = render(
      <MobileShellWrapper>
        <div>list</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute("data-full-viewport", "false")
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).toContain("min-h-[100dvh]")
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
