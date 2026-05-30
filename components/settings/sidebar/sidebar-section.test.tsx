/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { SidebarSection } from "./sidebar-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned: ["workflows"], hidden: [] } } as never,
    save: (async () => {}) as never,
  })
})

describe("SidebarSection", () => {
  it("renders the heading and the shared customizer", () => {
    render(
      <TooltipProvider>
        <SidebarSection />
      </TooltipProvider>
    )
    expect(screen.getByTestId("settings-sidebar-section")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "customize.title" })).toBeInTheDocument()
  })
})
