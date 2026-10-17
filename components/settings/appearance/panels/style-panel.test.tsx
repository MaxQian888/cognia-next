/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const save = jest.fn()
let settings: Record<string, unknown> = {}

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings, save }),
}))

jest.mock("../components/setting-slider-row", () => ({
  SettingSliderRow: ({ value, onChange }: { value: number; onChange: (n: number) => void }) => (
    <button data-testid="radius-slider" data-value={value} onClick={() => onChange(0)}>
      radius
    </button>
  ),
}))

import { StylePanel } from "./style-panel"
import { STYLE_PACK_IDS } from "@/types/appearance/style-pack"

beforeEach(() => {
  save.mockClear()
  settings = {}
})

describe("StylePanel", () => {
  it("defaults settings icons to anime and saves the ordinary preference", async () => {
    const user = userEvent.setup()
    render(<StylePanel />)
    expect(
      screen.getByRole("radio", { name: "settings.appearance.settingsIcons.anime" })
    ).toHaveAttribute("aria-checked", "true")
    await user.click(
      screen.getByRole("radio", { name: "settings.appearance.settingsIcons.ordinary" })
    )
    expect(save).toHaveBeenCalledWith({ settingsIconStyle: "ordinary" })
  })

  it("loads the saved ordinary preference and allows switching back to anime", async () => {
    const user = userEvent.setup()
    settings = { settingsIconStyle: "ordinary" }
    render(<StylePanel />)
    expect(
      screen.getByRole("radio", { name: "settings.appearance.settingsIcons.ordinary" })
    ).toHaveAttribute("aria-checked", "true")
    await user.click(screen.getByRole("radio", { name: "settings.appearance.settingsIcons.anime" }))
    expect(save).toHaveBeenCalledWith({ settingsIconStyle: "anime" })
  })

  it("does not clear the icon preference when clicking the selected style", async () => {
    const user = userEvent.setup()
    render(<StylePanel />)
    await user.click(screen.getByRole("radio", { name: "settings.appearance.settingsIcons.anime" }))
    expect(save).not.toHaveBeenCalled()
  })

  it("offers every pack", () => {
    render(<StylePanel />)
    for (const id of STYLE_PACK_IDS) {
      expect(screen.getByTestId(`style-pack-${id}`)).toBeInTheDocument()
    }
  })

  it("marks soft active when nothing is stored", () => {
    render(<StylePanel />)
    expect(screen.getByTestId("style-pack-soft")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("style-pack-sharp")).toHaveAttribute("aria-pressed", "false")
  })

  it("writes the chosen pack", () => {
    render(<StylePanel />)
    fireEvent.click(screen.getByTestId("style-pack-sharp"))
    expect(save).toHaveBeenCalledWith({ stylePack: { packId: "sharp" } })
  })

  it("keeps existing overrides when switching packs", () => {
    settings = { stylePack: { packId: "soft", overrides: { density: "compact" } } }
    render(<StylePanel />)
    fireEvent.click(screen.getByTestId("style-pack-studio"))
    expect(save).toHaveBeenCalledWith({
      stylePack: { packId: "studio", overrides: { density: "compact" } },
    })
  })

  it("offers a reset only once overrides exist", () => {
    render(<StylePanel />)
    expect(screen.queryByText(/resetOverrides/)).toBeNull()

    settings = { stylePack: { packId: "sharp", overrides: { density: "spacious" } } }
    render(<StylePanel />)
    fireEvent.click(screen.getByText(/resetOverrides/))
    expect(save).toHaveBeenCalledWith({ stylePack: { packId: "sharp" } })
  })

  /**
   * The radius slider and the pack both feed `--radius`, and the slider only
   * wins once moved off the stylesheet default (see `resolveRadiusVar`). The
   * panel has to say which one is in charge, or the number reads as a lie when
   * a pack is active.
   */
  it("says whether the radius slider is following or overriding the pack", () => {
    render(<StylePanel />)
    expect(screen.getByText(/radiusFollowsPack/)).toBeInTheDocument()

    settings = { radius: { base: 0 } }
    render(<StylePanel />)
    expect(screen.getByText(/radiusOverridesPack/)).toBeInTheDocument()
  })
})
