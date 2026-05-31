/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { DiscoverSection } from "./discover-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  useSettingsStore.setState({
    settings: { discoverLayout: { pinned: ["characters"], hidden: [] } } as never,
    save: (async () => {}) as never,
  })
})

describe("DiscoverSection", () => {
  it("renders the heading and the shared customizer", () => {
    render(
      <TooltipProvider>
        <DiscoverSection />
      </TooltipProvider>
    )
    expect(screen.getByTestId("settings-discover-section")).toBeInTheDocument()
    expect(screen.getByTestId("discover-customizer")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "customize.title" })).toBeInTheDocument()
  })
})
