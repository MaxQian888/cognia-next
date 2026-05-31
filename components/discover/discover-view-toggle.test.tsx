/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

import { DiscoverViewToggle } from "./discover-view-toggle"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_patch?: { discoverViewByCategory?: Record<string, string> }) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { discoverViewByCategory: { characters: "list" } } as never,
    save: saveMock as never,
  })
})

describe("DiscoverViewToggle", () => {
  it("reflects the stored mode for the category", () => {
    render(<DiscoverViewToggle category="characters" />)
    expect(screen.getByTestId("discover-view-list")).toHaveAttribute("data-state", "on")
  })

  it("defaults to grid for an unset category", () => {
    render(<DiscoverViewToggle category="plugins" />)
    expect(screen.getByTestId("discover-view-grid")).toHaveAttribute("data-state", "on")
  })

  it("persists the chosen mode for that category", () => {
    render(<DiscoverViewToggle category="plugins" />)
    fireEvent.click(screen.getByTestId("discover-view-compact"))
    expect(saveMock).toHaveBeenCalledWith({
      discoverViewByCategory: { characters: "list", plugins: "compact" },
    })
  })
})
