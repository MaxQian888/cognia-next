/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}))

const setTheme = jest.fn()
let theme = "system"
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme, setTheme }),
}))

const save = jest.fn(async () => {})
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T): T => selector({ save }),
}))

jest.mock("@/components/chat/shared-session-join", () => ({
  SharedSessionJoin: () => <div data-testid="shared-session-join" />,
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => <div data-testid={`slot-${point}`} />,
}))
// The account card has its own suite (`sidebar-user-card.test.tsx`), so here it
// is a stub and this file keeps testing what the footer itself decides.
jest.mock("./sidebar-user-card", () => ({
  SidebarUserCard: ({ className }: { className?: string }) => (
    <div data-testid="sidebar-user-card" className={className} />
  ),
}))

import { SidebarFooter } from "./sidebar-footer"

beforeEach(() => {
  routerPush.mockClear()
  setTheme.mockClear()
  save.mockClear()
  theme = "system"
})

describe("SidebarFooter", () => {
  it("ends the rail on the account card, over the rail's bottom plugin slot", () => {
    render(<SidebarFooter />)
    const footer = screen.getByTestId("sidebar-footer")
    expect(footer).toContainElement(screen.getByTestId("slot-sidebar.left.bottom"))
    expect(footer).toContainElement(screen.getByTestId("sidebar-user-card"))
    expect(footer).toContainElement(screen.getByTestId("shared-session-join"))
  })

  it("keeps theme and settings one click away beside the card", () => {
    // The menu inside the card keeps them discoverable; the buttons keep them
    // a single press — the footer's trailing edge was dead space before.
    render(<SidebarFooter />)
    expect(screen.getByTestId("sidebar-footer-theme")).toHaveAccessibleName("themeAria")
    const settings = screen.getByTestId("sidebar-footer-settings")
    expect(settings).toHaveAccessibleName("settings")
    fireEvent.click(settings)
    expect(routerPush).toHaveBeenCalledWith("/settings")
  })

  it("cycles theme through the same stops the mobile tile does, and persists the choice", () => {
    const { rerender } = render(<SidebarFooter />)
    const toggle = screen.getByTestId("sidebar-footer-theme")
    // system → light → dark → system (THEME_CYCLE).
    fireEvent.click(toggle)
    expect(setTheme).toHaveBeenLastCalledWith("light")
    expect(save).toHaveBeenLastCalledWith({ theme: "light" })
    theme = "dark"
    rerender(<SidebarFooter />)
    fireEvent.click(toggle)
    expect(setTheme).toHaveBeenLastCalledWith("system")
    expect(save).toHaveBeenLastCalledWith({ theme: "system" })
  })

  it("takes a caller's class so the rail can place it", () => {
    render(<SidebarFooter className="mt-2" />)
    expect(screen.getByTestId("sidebar-footer")).toHaveClass("mt-2")
  })
})
