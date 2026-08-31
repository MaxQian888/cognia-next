/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"

import { MobileShellWrapper } from "./mobile-shell-wrapper"
import { useSettingsStore as realSettingsStore } from "@/stores/settings/settings-store"
import type { MobileTabLayout } from "@/types/shell/mobile-tabs"

const platformMock = jest.fn(() => "mobile")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformMock(),
}))

// The second signal. `platformMock` says which runtime this is; this one says
// whether the viewport is narrow. They disagree exactly where the bug was: a
// 375px browser is `web` + compact.
const compactMock = jest.fn(() => false)
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compactMock(),
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

jest.mock("@/components/file-viewer/file-viewer-dialog", () => ({
  FileViewerDialog: () => <div data-testid="file-viewer-dialog" />,
}))

jest.mock("@/components/mobile/offline-banner", () => ({
  OfflineBanner: () => <div data-testid="offline-banner-stub" />,
}))

// Native-only chrome. Stubbed so the suite can assert it is ABSENT on a narrow
// browser, which is the half of the split that is easy to get wrong.
jest.mock("@/components/mobile/automation/mobile-consent-sheet", () => ({
  MobileConsentSheet: () => <div data-testid="mobile-consent-sheet-stub" />,
}))

// Stubbed for the same reason as the banner above: what this suite pins is
// that the shell mounts it as a row of its own chrome, not the bar's own
// self-hiding rules (those live in finish-setup-bar.test.tsx).
jest.mock("@/components/onboarding/finish-setup-bar", () => ({
  FinishSetupBar: () => <div data-testid="finish-setup-bar-stub" />,
}))

// The real host drags the whole global-search stack (Dexie providers, next-intl
// formatters) into every wrapper test; the mount itself is what matters here.
jest.mock("./mobile-global-search-host", () => ({
  MobileGlobalSearchHost: () => <div data-testid="mobile-global-search-host" />,
}))

const inboundUnreadRef = { value: 0 }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => inboundUnreadRef.value,
}))

const keyboardRef = { value: { keyboardHeight: 0, isVisible: false } }
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => keyboardRef.value,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    inboundLedger: {
      where: () => ({ above: () => ({ count: () => Promise.resolve(0) }) }),
    },
  }),
}))

const wrapperStoreState: {
  settings: { lastInboxViewedAt: number } | null
  loaded: boolean
} = { settings: { lastInboxViewedAt: 0 }, loaded: true }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof wrapperStoreState) => unknown) =>
    selector(wrapperStoreState),
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
    compactMock.mockReset().mockReturnValue(false)
    pathnameMock.mockReset().mockReturnValue("/")
    inboundUnreadRef.value = 0
    keyboardRef.value = { keyboardHeight: 0, isVisible: false }
    replaceMock.mockReset()
    wrapperStoreState.settings = { lastInboxViewedAt: 0 }
    wrapperStoreState.loaded = true
    // The tab bar + landing redirect read the real settings-store (the
    // `@/stores/settings` mock above only covers the wrapper's own selector).
    realSettingsStore.setState({ settings: null } as never)
  })

  function setTabLayout(layout: MobileTabLayout) {
    act(() => {
      realSettingsStore.setState({ settings: { mobileTabLayout: layout } } as never)
    })
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

  it("mounts the finish-setup notice inside the shell, above the page", () => {
    // It used to be mounted at the body level in `app/layout.tsx`, which put it
    // *after* a `min-h-[100dvh]` page — off the bottom of the document, where
    // it only ever showed up as an unexplained scrollbar.
    render(
      <MobileShellWrapper>
        <div>child</div>
      </MobileShellWrapper>
    )
    const bar = screen.getByTestId("finish-setup-bar-stub")
    expect(bar).toBeInTheDocument()
    expect(
      bar.compareDocumentPosition(screen.getByText("child")) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("mounts the file viewer dialog for every mobile route", () => {
    // `DesktopAppShell` mounts its own copy but returns bare children on this
    // platform, so without this one a file link in the mobile terminal or in
    // chat wrote to the store and showed nothing at all.
    render(
      <MobileShellWrapper>
        <div>child</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("file-viewer-dialog")).toBeInTheDocument()

    // Including the routes that render outside `AppShellMobile` — the terminal
    // is one of the two places a file link is actually clicked.
    pathnameMock.mockReturnValue("/me/terminal")
    render(
      <MobileShellWrapper>
        <div>terminal</div>
      </MobileShellWrapper>
    )
    expect(screen.getAllByTestId("file-viewer-dialog").length).toBeGreaterThan(0)
  })

  it("mounts the global-search host for every mobile route", () => {
    // `AppShellMobile` renders only on `/`, so without this mount ⌘K and the
    // settings header's search button dispatched into nothing on /settings,
    // /inbox and /me/* (ADR-0129).
    pathnameMock.mockReturnValue("/settings")
    render(
      <MobileShellWrapper>
        <div>settings</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-global-search-host")).toBeInTheDocument()
  })

  it("leaves the file viewer dialog to the desktop shell when it owns the frame", () => {
    // Both shells mount one. The shared `usesCompactShell` predicate is what
    // keeps exactly one of them rendering rather than two dialogs fighting
    // over the same store.
    platformMock.mockReturnValue("desktop")
    render(
      <MobileShellWrapper>
        <div>child</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("file-viewer-dialog")).not.toBeInTheDocument()
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
  })

  it("mobile: mounts OfflineBanner", () => {
    platformMock.mockReturnValue("mobile")
    render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("offline-banner-stub")).toBeInTheDocument()
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

  it("does not hijack navigation when the landing setting changes after launch", () => {
    // Launch at "/" with the default (chat) landing — decision is made once.
    const { rerender } = render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()

    // The user later changes "default landing" in /me settings — the wrapper
    // must NOT rip them out of the settings screen.
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    rerender(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("waits for settings hydration before deciding the landing tab", () => {
    wrapperStoreState.loaded = false
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    const { rerender } = render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    // Not hydrated yet — no decision, no redirect.
    expect(replaceMock).not.toHaveBeenCalled()

    wrapperStoreState.loaded = true
    rerender(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).toHaveBeenCalledWith("/workflows")
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

  it("reserves the full viewport for the terminal and hides the mobile tab bar", () => {
    pathnameMock.mockReturnValue("/me/terminal")
    render(
      <MobileShellWrapper>
        <div>terminal</div>
      </MobileShellWrapper>
    )
    const wrapper = screen.getByTestId("mobile-shell-wrapper")
    expect(wrapper).toHaveAttribute("data-full-viewport", "true")
    expect(wrapper).toHaveAttribute("data-tab-bar-visible", "false")
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
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

  it("gives the first-run flow a definite full-viewport height with the tab bar hidden", () => {
    pathnameMock.mockReturnValue("/onboarding")
    const { container } = render(
      <MobileShellWrapper>
        <div>onboarding</div>
      </MobileShellWrapper>
    )
    const wrapper = screen.getByTestId("mobile-shell-wrapper")
    expect(wrapper).toHaveAttribute("data-full-viewport", "true")
    expect(wrapper).toHaveAttribute("data-tab-bar-visible", "false")
    // `StepShell` is `h-full` (it fills the desktop chrome's content slot);
    // on mobile that chain only resolves against a definite-height column.
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).toContain("h-[100dvh]")
    expect(inner?.className).not.toContain("min-h-[100dvh]")
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
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

  it("slides the tab bar away and drops the bottom reserve while the keyboard is open", () => {
    keyboardRef.value = { keyboardHeight: 320, isVisible: true }
    const { container } = render(
      <MobileShellWrapper>
        <div>typing</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute(
      "data-keyboard-visible",
      "true"
    )
    // Bar stays mounted (no entrance-stagger replay) but is translated off.
    const bar = screen.getByTestId("mobile-tab-bar")
    expect(bar).toHaveAttribute("data-keyboard-hidden", "true")
    expect(bar.className).toContain("translate-y-full")
    // The content column no longer reserves the tab-bar height.
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).not.toContain("pb-[calc(theme(spacing.14)")
  })

  it("lifts the content by the keyboard overlap when the frame did not resize", () => {
    // Native-resize failed (iOS quirk / plugin missing): overlap is real.
    keyboardRef.value = { keyboardHeight: 260, isVisible: true }
    const { container } = render(
      <MobileShellWrapper>
        <div>typing</div>
      </MobileShellWrapper>
    )
    const inner = container.querySelector(
      "[data-testid='mobile-shell-wrapper'] > div"
    ) as HTMLElement
    expect(inner.style.paddingBottom).toBe("260px")
  })

  it("adds no overlap padding when native resize already handled the keyboard", () => {
    // resize:"native" worked: keyboard open but zero overlap.
    keyboardRef.value = { keyboardHeight: 0, isVisible: true }
    const { container } = render(
      <MobileShellWrapper>
        <div>typing</div>
      </MobileShellWrapper>
    )
    const inner = container.querySelector(
      "[data-testid='mobile-shell-wrapper'] > div"
    ) as HTMLElement
    expect(inner.style.paddingBottom).toBe("")
  })

  it("restores the tab bar and bottom reserve when the keyboard closes", () => {
    keyboardRef.value = { keyboardHeight: 320, isVisible: true }
    const { container, rerender } = render(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    keyboardRef.value = { keyboardHeight: 0, isVisible: false }
    rerender(
      <MobileShellWrapper>
        <div>x</div>
      </MobileShellWrapper>
    )
    const bar = screen.getByTestId("mobile-tab-bar")
    expect(bar).toHaveAttribute("data-keyboard-hidden", "false")
    expect(bar.className).not.toContain("translate-y-full")
    const inner = container.querySelector("[data-testid='mobile-shell-wrapper'] > div")
    expect(inner?.className).toContain("pb-[calc(theme(spacing.14)")
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

  it("takes the frame on a narrow BROWSER, which used to get the desktop shell", () => {
    // The regression this split exists for: `web` + 375px. The old gate asked
    // `platform === "mobile"`, answered false, and handed the page to
    // `DesktopAppShell`, whose `GuildRail` is `hidden md:flex`. Net result was
    // a phone-width viewport with no navigation at all.
    platformMock.mockReturnValue("web")
    compactMock.mockReturnValue(true)
    render(
      <MobileShellWrapper>
        <div data-testid="child">narrow web</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-tab-bar")).toBeInTheDocument()
    expect(screen.getByTestId("child")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-shell-wrapper")).toHaveAttribute(
      "data-compact-shell",
      "true"
    )
  })

  it("does not mount the native consent sheet on a narrow browser", () => {
    // Layout came across; native side effects did not. A browser window has no
    // OS automation-consent request to answer.
    platformMock.mockReturnValue("web")
    compactMock.mockReturnValue(true)
    render(
      <MobileShellWrapper>
        <div>narrow web</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-consent-sheet-stub")).not.toBeInTheDocument()
  })

  it("still mounts the native consent sheet on a real mobile shell", () => {
    platformMock.mockReturnValue("mobile")
    render(
      <MobileShellWrapper>
        <div>phone</div>
      </MobileShellWrapper>
    )
    expect(screen.getByTestId("mobile-consent-sheet-stub")).toBeInTheDocument()
  })

  it("does not fire the launch landing redirect on a narrow browser", () => {
    // The redirect models an app launch. Resizing a browser window is not one.
    platformMock.mockReturnValue("web")
    compactMock.mockReturnValue(true)
    setTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: [],
      defaultLanding: "workflows",
    })
    render(
      <MobileShellWrapper>
        <div>narrow web</div>
      </MobileShellWrapper>
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("never takes the frame from Tauri, however narrow the window gets", () => {
    // The desktop window is `decorations: false`, so `TitleBar` carries the
    // close / minimise / maximise controls. Handing the frame to this shell
    // would take them away.
    platformMock.mockReturnValue("tauri")
    compactMock.mockReturnValue(true)
    render(
      <MobileShellWrapper>
        <div data-testid="child">narrow tauri</div>
      </MobileShellWrapper>
    )
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument()
    expect(screen.getByTestId("child")).toBeInTheDocument()
  })

})
