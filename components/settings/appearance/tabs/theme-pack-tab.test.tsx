/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const setActiveWallpaper = jest.fn()
const setActiveCustomTheme = jest.fn()
const createCustomTheme = jest.fn(() => "ct1")

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: {},
      save,
      setActiveWallpaper,
      setActiveCustomTheme,
      createCustomTheme,
    }),
}))

import { ThemePackTab } from "./theme-pack-tab"
import {
  registerThemePack,
  __resetThemePackRegistryForTesting,
} from "@/lib/theme/theme-pack-registry"

beforeEach(() => {
  jest.clearAllMocks()
  __resetThemePackRegistryForTesting()
})

describe("ThemePackTab", () => {
  it("shows the empty state when no packs are registered", () => {
    render(<ThemePackTab />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists registered packs and applies one on click", () => {
    registerThemePack({
      pluginId: "demo",
      pluginName: "Demo",
      pack: {
        id: "sunset",
        name: "Sunset",
        description: "warm",
        applies: { themeId: "sunset", radius: 0.5 },
      },
    })
    render(<ThemePackTab />)
    expect(screen.getByText("Sunset")).toBeInTheDocument()
    fireEvent.click(screen.getByText("apply"))
    // "sunset" is a host colour preset → save({ colorTheme }) + radius write.
    expect(save).toHaveBeenCalledWith({ colorTheme: "sunset" })
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ radius: expect.objectContaining({ base: 0.5 }) })
    )
  })
})
