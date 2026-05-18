/**
 * @jest-environment jsdom
 *
 * Covers the platform gate / desktop-redirect behavior added in
 * `app/me/page.tsx`. The full mobile body is heavily dependency-laden
 * (multiple mobile cards, transport-companion calls); we stub every
 * downstream component so the unit under test is the gate itself.
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

jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: jest.fn().mockResolvedValue(null),
}))

jest.mock("@/components/mobile/backup/mobile-backup-section", () => ({
  MobileBackupSection: () => <div data-testid="stub-backup" />,
}))
jest.mock("@/components/mobile/settings/mobile-settings-panel", () => ({
  MobileSettingsPanel: () => <div data-testid="stub-settings" />,
}))
jest.mock("@/components/mobile/me/profile-header", () => ({
  ProfileHeader: () => <div data-testid="stub-profile-header" />,
}))
jest.mock("@/components/mobile/me/today-stats-card", () => ({
  TodayStatsCard: () => <div data-testid="stub-today-stats" />,
}))
jest.mock("@/components/mobile/me/quick-toggles", () => ({
  QuickToggles: () => <div data-testid="stub-quick-toggles" />,
}))

import MePage from "./page"

beforeEach(() => {
  routerReplace.mockReset()
  platformValue = "web"
})

describe("MePage platform gate", () => {
  it("renders the mobile body when platform === 'mobile'", () => {
    platformValue = "mobile"
    render(<MePage />)
    expect(screen.getByTestId("me-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-profile-header")).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
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
