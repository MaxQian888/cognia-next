/**
 * @jest-environment jsdom
 *
 * Covers the platform gate / desktop-redirect plus the data-driven section
 * composition, search filtering, and pinned-favorites behavior in
 * `app/me/page.tsx`. The heavyweight card/row dependencies are stubbed so the
 * unit under test is the page's own composition logic. `MeRow` / `MeSection`
 * render for real (as in the original test) so the `me-row-*` / `me-section-*`
 * ids and hrefs are exercised end-to-end.
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: jest.fn(), back: jest.fn() }),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

const companionConfigState = {
  current: { paired: false, shortDeviceId: null as string | null },
}
jest.mock("@/hooks/companion/use-companion-config", () => ({
  useCompanionConfig: () => ({
    config: null,
    paired: companionConfigState.current.paired,
    shortDeviceId: companionConfigState.current.shortDeviceId,
    loading: false,
    reload: jest.fn(async () => undefined),
  }),
}))

const pinnedState = { current: [] as string[] }
const togglePinMock = jest.fn()
jest.mock("@/components/mobile/me/use-pinned-me-rows", () => ({
  usePinnedMeRows: () => ({
    pinnedIds: pinnedState.current,
    isPinned: (id: string) => pinnedState.current.includes(id),
    togglePin: togglePinMock,
  }),
}))

const syncStates = { current: {} as Record<string, { lastSyncAt: number | null }> }
jest.mock("@/lib/sync/companion-sync", () => ({
  snapshotSyncStates: () => syncStates.current,
}))

// Long-press is a thin gesture wrapper — pass children straight through.
jest.mock("@/components/interactions/long-press", () => ({
  LongPress: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// A controllable search input so we can drive the query.
jest.mock("@/components/mobile/discover/discover-search", () => ({
  DiscoverSearch: ({
    value,
    onChange,
    testid,
  }: {
    value: string
    onChange: (v: string) => void
    testid?: string
  }) => (
    <input
      data-testid={`${testid ?? "discover-search"}-input`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

jest.mock("@/components/mobile/me/account-card", () => ({
  AccountCard: () => <div data-testid="stub-account-card" />,
}))
jest.mock("@/components/mobile/me/today-stats-card", () => ({
  TodayStatsCard: () => <div data-testid="stub-today-stats" />,
}))
jest.mock("@/components/mobile/me/backup-reminder-banner", () => ({
  BackupReminderBanner: () => <div data-testid="stub-backup-reminder" />,
}))
jest.mock("@/components/mobile/me/quick-action-grid", () => ({
  QuickActionGrid: () => <div data-testid="stub-quick-action-grid" />,
}))
jest.mock("@/components/mobile/me/transport-tier-indicator", () => ({
  TransportTierIndicator: () => <div data-testid="stub-transport-tier" />,
}))
jest.mock("@/components/mobile/notifications/notification-permission-cta", () => ({
  NotificationPermissionCta: () => <div data-testid="stub-notif-cta" />,
}))
jest.mock("@/components/mobile/me/version-row", () => ({
  VersionRow: () => <div data-testid="stub-version-row" />,
}))
jest.mock("@/components/mobile/me/sign-out-button", () => ({
  SignOutButton: () => <button type="button" data-testid="stub-sign-out" />,
}))
jest.mock("@/components/mobile/connection-state-badge", () => ({
  ConnectionStateBadge: () => <div data-testid="stub-connection-badge" />,
}))

import MePage from "./page"

beforeEach(() => {
  routerReplace.mockReset()
  togglePinMock.mockReset()
  platformValue = "web"
  companionConfigState.current = { paired: false, shortDeviceId: null }
  pinnedState.current = []
  syncStates.current = {}
})

function hrefOf(testid: string): string | null | undefined {
  const row = screen.getByTestId(testid)
  const link = row.closest("a") || row.querySelector("a")
  return link?.getAttribute("href")
}

describe("MePage platform gate", () => {
  it("renders the mobile body when platform === 'mobile'", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(screen.getByTestId("me-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-account-card")).toBeInTheDocument()
    expect(screen.getByTestId("stub-today-stats")).toBeInTheDocument()
    expect(screen.getByTestId("stub-quick-action-grid")).toBeInTheDocument()
    expect(screen.getByTestId("stub-connection-badge")).toBeInTheDocument()
    expect(screen.getByTestId("stub-transport-tier")).toBeInTheDocument()
    expect(screen.getByTestId("stub-notif-cta")).toBeInTheDocument()
    expect(screen.getByTestId("stub-backup-reminder")).toBeInTheDocument()
    expect(screen.getByTestId("stub-sign-out")).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it("emphasizes the sticky header once the body is scrolled", () => {
    platformValue = "mobile"
    const { container } = render(<MePage />)
    const main = screen.getByTestId("me-page")
    const header = container.querySelector("header")
    expect(header).toHaveAttribute("data-scrolled", "false")
    fireEvent.scroll(main, { target: { scrollTop: 40 } })
    expect(header).toHaveAttribute("data-scrolled", "true")
    expect(header?.className).toMatch(/shadow-sm/)
  })

  it("renders all six MeSection groups", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(screen.getByTestId("me-section-account")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-appearance")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-connection")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-automation")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-data")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-about")).toBeInTheDocument()
  })

  it("reflows the section grid responsively (2-col tablet, 3-col landscape)", () => {
    platformValue = "mobile"
    const { container } = render(<MePage />)
    const grid = container.querySelector(".grid")
    expect(grid?.className).toMatch(/sm:grid-cols-2/)
    expect(grid?.className).toMatch(/lg:grid-cols-3/)
    // The content column widens with the 3-col grid so columns stay readable.
    expect(grid?.parentElement?.className).toMatch(/lg:max-w-4xl/)
  })

  it("renders the scheduler row in the automation section pointing at /me/scheduler", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(screen.getByTestId("me-row-scheduler")).toBeInTheDocument()
    expect(hrefOf("me-row-scheduler")).toBe("/me/scheduler")
  })

  it("renders companion illustrations on the selected core feature entries", () => {
    platformValue = "mobile"
    render(<MePage />)

    expect(screen.getByTestId("mobile-spot-icon-profile")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-workflows")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-secure-backup")).toBeInTheDocument()
  })

  it("surfaces the new terminal and remote-sessions entries", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(hrefOf("me-row-terminal")).toBe("/me/terminal")
    expect(hrefOf("me-row-remote-sessions")).toBe("/remote-sessions")
  })

  it("shows the 'Pair now' row only when unpaired", () => {
    platformValue = "mobile"
    companionConfigState.current = { paired: false, shortDeviceId: null }
    const { rerender } = render(<MePage />)
    expect(screen.getByTestId("me-row-pair")).toBeInTheDocument()

    companionConfigState.current = { paired: true, shortDeviceId: "ABCDEFGH" }
    rerender(<MePage />)
    expect(screen.queryByTestId("me-row-pair")).toBeNull()
  })

  it("shows the short deviceId on the devices row when paired", () => {
    platformValue = "mobile"
    companionConfigState.current = { paired: true, shortDeviceId: "ABCDEFGH" }
    render(<MePage />)
    expect(screen.getByTestId("me-row-devices")).toHaveTextContent("ABCDEFGH")
  })

  it("shows the last-synced stamp on the sync row when sync state exists", () => {
    platformValue = "mobile"
    syncStates.current = { sessions: { lastSyncAt: Date.now() - 120_000 } }
    render(<MePage />)
    expect(screen.getByTestId("me-row-sync")).toHaveTextContent(/ago/)
  })

  it("renders null and redirects to the account overview on web", () => {
    platformValue = "web"
    const { container } = render(<MePage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/settings?section=account")
  })

  it("renders null and redirects to the account overview on Tauri", () => {
    platformValue = "tauri"
    const { container } = render(<MePage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/settings?section=account")
  })
})

describe("MePage search", () => {
  it("filters to matching rows and hides the grouped sections", () => {
    platformValue = "mobile"
    render(<MePage />)
    fireEvent.change(screen.getByTestId("me-search-input"), { target: { value: "backup" } })
    expect(screen.getByTestId("me-search-results")).toBeInTheDocument()
    expect(screen.getByTestId("me-row-backup")).toBeInTheDocument()
    // Non-matching rows and the normal grouped layout are gone.
    expect(screen.queryByTestId("me-row-subscription")).toBeNull()
    expect(screen.queryByTestId("me-section-account")).toBeNull()
  })

  it("shows an empty state when nothing matches", () => {
    platformValue = "mobile"
    render(<MePage />)
    fireEvent.change(screen.getByTestId("me-search-input"), { target: { value: "zzzzzzz" } })
    expect(screen.getByTestId("me-search-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("me-search-results")).toBeNull()
  })
})

describe("MePage favorites", () => {
  it("hides the favorites section when nothing is pinned", () => {
    platformValue = "mobile"
    pinnedState.current = []
    render(<MePage />)
    expect(screen.queryByTestId("me-section-favorites")).toBeNull()
  })

  it("renders pinned rows in a favorites section above the groups", () => {
    platformValue = "mobile"
    pinnedState.current = ["sync", "backup"]
    render(<MePage />)
    expect(screen.getByTestId("me-section-favorites")).toBeInTheDocument()
    expect(screen.getByTestId("me-row-fav-sync")).toBeInTheDocument()
    expect(screen.getByTestId("me-row-fav-backup")).toBeInTheDocument()
    // The same rows still appear in their normal groups (distinct ids).
    expect(screen.getByTestId("me-row-sync")).toBeInTheDocument()
  })
})
