import { render, screen, fireEvent } from "@testing-library/react"

const save = jest.fn()
let settings: Record<string, unknown> = {}

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings, save }),
}))

import { StylePackPicker } from "./style-pack-picker"
import { STYLE_PACK_IDS } from "@/types/appearance/style-pack"

beforeEach(() => {
  save.mockClear()
  settings = {}
})

describe("StylePackPicker", () => {
  it("offers every pack and marks soft active by default", () => {
    render(<StylePackPicker />)
    for (const id of STYLE_PACK_IDS) {
      expect(screen.getByTestId(`style-pack-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("style-pack-soft")).toHaveAttribute("aria-pressed", "true")
  })

  it("writes the chosen pack and keeps existing overrides", () => {
    settings = { stylePack: { packId: "soft", overrides: { density: "compact" } } }
    render(<StylePackPicker />)
    fireEvent.click(screen.getByTestId("style-pack-sharp"))
    expect(save).toHaveBeenCalledWith({
      stylePack: { packId: "sharp", overrides: { density: "compact" } },
    })
  })

  it("drops the descriptions in compact mode, for onboarding's narrower column", () => {
    const { rerender } = render(<StylePackPicker />)
    expect(screen.getByText(/packs\.sharp\.description/)).toBeInTheDocument()
    rerender(<StylePackPicker compact />)
    expect(screen.queryByText(/packs\.sharp\.description/)).toBeNull()
    // The name stays either way — a preview with no label is a guess.
    expect(screen.getByText(/packs\.sharp\.name/)).toBeInTheDocument()
  })

  /**
   * The preview scopes the same custom properties `StylePackApplier` writes
   * onto <html>. If it drifted onto a private mechanism it would stop
   * predicting what selecting the pack actually does.
   */
  it("previews each pack through the real pack variables", () => {
    const { container } = render(<StylePackPicker />)
    const previews = container.querySelectorAll<HTMLElement>('[aria-hidden="true"][style]')
    expect(previews.length).toBe(STYLE_PACK_IDS.length)
    const sharp = screen
      .getByTestId("style-pack-sharp")
      .querySelector<HTMLElement>('[aria-hidden="true"][style]')
    expect(sharp?.style.getPropertyValue("--radius")).toBe("0rem")
    expect(sharp?.style.getPropertyValue("--pill-radius")).toBe("0px")
  })
})
