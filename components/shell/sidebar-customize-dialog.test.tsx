/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { SidebarCustomizeDialog } from "./sidebar-customize-dialog"
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

describe("SidebarCustomizeDialog", () => {
  it("renders the customizer when open", () => {
    render(
      <TooltipProvider>
        <SidebarCustomizeDialog open onOpenChange={() => {}} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("sidebar-customize-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
  })

  it("renders nothing when closed", () => {
    render(
      <TooltipProvider>
        <SidebarCustomizeDialog open={false} onOpenChange={() => {}} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("sidebar-customize-dialog")).not.toBeInTheDocument()
  })
})
