/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ShellLayoutSection } from "./shell-layout-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

beforeEach(() => {
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned: ["workflows"], hidden: [] } } as never,
    save: (async () => {}) as never,
  })
})

const renderSection = () =>
  render(
    <TooltipProvider>
      <ShellLayoutSection />
    </TooltipProvider>
  )

describe("ShellLayoutSection", () => {
  it("renders the heading and opens on the sidebar customizer", () => {
    renderSection()
    expect(screen.getByTestId("settings-shell-layout-section")).toBeInTheDocument()
    expect(screen.getByTestId("shell-layout-customizer")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "desktop.shellLayout.title" })).toBeInTheDocument()
  })

  it("offers a tab for each shell surface", () => {
    renderSection()
    for (const surface of ["sidebar", "title", "status"]) {
      expect(screen.getByTestId(`shell-layout-tab-${surface}`)).toBeInTheDocument()
    }
  })

  it("switches to the top-bar customizer", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByTestId("shell-layout-tab-title"))
    expect(await screen.findByTestId("bar-customizer-title")).toBeInTheDocument()
  })

  it("switches to the bottom-bar customizer", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByTestId("shell-layout-tab-status"))
    expect(await screen.findByTestId("bar-customizer-status")).toBeInTheDocument()
  })
})
