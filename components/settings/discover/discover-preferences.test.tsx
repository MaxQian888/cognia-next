/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverPreferences } from "./discover-preferences"
import { useSettingsStore } from "@/stores/settings/settings-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_patch?: unknown) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: {
      discoverLayout: { pinned: ["characters", "skills"], hidden: [] },
      discoverDefaults: { landingCategory: "skills", view: "list" },
    } as never,
    save: saveMock as never,
  })
})

const lastPatch = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as {
    discoverDefaults?: { landingCategory?: string; view?: string }
  }

describe("<DiscoverPreferences />", () => {
  it("renders both selects seeded from settings", () => {
    render(<DiscoverPreferences />)
    expect(screen.getByTestId("discover-preferences")).toBeInTheDocument()
    expect(screen.getByTestId("discover-landing-select")).toHaveValue("skills")
    expect(screen.getByTestId("discover-view-select")).toHaveValue("list")
  })

  it("offers auto + favorites + visible categories, but never hidden ones", () => {
    useSettingsStore.setState({
      settings: {
        discoverLayout: { pinned: ["characters", "skills"], hidden: ["twinDrafts"] },
        discoverDefaults: { landingCategory: "skills", view: "list" },
      } as never,
      save: saveMock as never,
    })
    render(<DiscoverPreferences />)
    const select = screen.getByTestId("discover-landing-select")
    const values = Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"))
    expect(values).toContain("") // auto
    expect(values).toContain("favorites")
    expect(values).toContain("characters")
    expect(values).toContain("skills")
    // The hidden category is excluded from the landing options.
    expect(values).not.toContain("twinDrafts")
  })

  it("persists a chosen landing category", async () => {
    const user = userEvent.setup()
    render(<DiscoverPreferences />)
    await user.selectOptions(screen.getByTestId("discover-landing-select"), "characters")
    expect(lastPatch().discoverDefaults).toEqual(
      expect.objectContaining({ landingCategory: "characters" })
    )
  })

  it("persists the auto landing by dropping the key", async () => {
    const user = userEvent.setup()
    render(<DiscoverPreferences />)
    await user.selectOptions(screen.getByTestId("discover-landing-select"), "")
    expect(lastPatch().discoverDefaults?.landingCategory).toBeUndefined()
  })

  it("persists a chosen default view", async () => {
    const user = userEvent.setup()
    render(<DiscoverPreferences />)
    await user.selectOptions(screen.getByTestId("discover-view-select"), "compact")
    expect(lastPatch().discoverDefaults).toEqual(expect.objectContaining({ view: "compact" }))
  })

  it("reset is enabled when defaults differ and wipes them", async () => {
    const user = userEvent.setup()
    render(<DiscoverPreferences />)
    const reset = screen.getByTestId("discover-preferences-reset")
    expect(reset).toBeEnabled()
    await user.click(reset)
    expect(lastPatch().discoverDefaults).toEqual({})
  })

  it("reset is disabled when preferences are already at defaults", () => {
    useSettingsStore.setState({
      settings: { discoverLayout: { pinned: [], hidden: [] } } as never,
      save: saveMock as never,
    })
    render(<DiscoverPreferences />)
    expect(screen.getByTestId("discover-preferences-reset")).toBeDisabled()
  })
})
