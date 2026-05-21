/**
 * @jest-environment jsdom
 *
 * Covers the platform gate / desktop-redirect behavior in
 * `app/me/page.tsx`. The mobile body is heavily dependency-laden, so we
 * stub every downstream component to keep the unit under test as just
 * the gate + section composition.
 */
import { render, screen } from "@testing-library/react"

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

jest.mock("@/components/mobile/me/account-card", () => ({
  AccountCard: () => <div data-testid="stub-account-card" />,
}))
jest.mock("@/components/mobile/me/today-stats-card", () => ({
  TodayStatsCard: () => <div data-testid="stub-today-stats" />,
}))
jest.mock("@/components/mobile/me/quick-action-grid", () => ({
  QuickActionGrid: () => <div data-testid="stub-quick-action-grid" />,
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
  platformValue = "web"
  companionConfigState.current = { paired: false, shortDeviceId: null }
})

describe("MePage platform gate", () => {
  it("renders the mobile body when platform === 'mobile'", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(screen.getByTestId("me-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-account-card")).toBeInTheDocument()
    expect(screen.getByTestId("stub-today-stats")).toBeInTheDocument()
    expect(screen.getByTestId("stub-quick-action-grid")).toBeInTheDocument()
    expect(screen.getByTestId("stub-connection-badge")).toBeInTheDocument()
    expect(screen.getByTestId("stub-sign-out")).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
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

  it("renders the scheduler row in the automation section pointing at /me/scheduler", () => {
    platformValue = "mobile"
    render(<MePage />)
    const row = screen.getByTestId("me-row-scheduler")
    expect(row).toBeInTheDocument()
    const link = row.closest("a") || row.querySelector("a")
    expect(link?.getAttribute("href")).toBe("/me/scheduler")
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

  it("renders null and redirects to /settings on web", () => {
    platformValue = "web"
    const { container } = render(<MePage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/settings")
  })

  it("renders null and redirects to /settings on Tauri", () => {
    platformValue = "tauri"
    const { container } = render(<MePage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/settings")
  })
})
