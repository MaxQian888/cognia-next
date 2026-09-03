/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

let resolvedTheme = "dark"

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}))

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
  resolvedTheme = "dark"
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

  it("renders the preview matching the resolved app theme", () => {
    registerThemePack({
      pluginId: "demo",
      pack: {
        id: "ops",
        name: "Operations",
        preview: { light: "/plugins/demo/light.webp", dark: "/plugins/demo/dark.webp" },
        applies: {},
      },
    })

    const { rerender } = render(<ThemePackTab />)
    expect(screen.getByTestId("theme-pack-preview-ops")).toHaveAttribute(
      "src",
      "/plugins/demo/dark.webp"
    )

    resolvedTheme = "light"
    rerender(<ThemePackTab />)
    expect(screen.getByTestId("theme-pack-preview-ops")).toHaveAttribute(
      "src",
      "/plugins/demo/light.webp"
    )
  })

  it("falls back to the available preview variant", () => {
    registerThemePack({
      pluginId: "demo",
      pack: {
        id: "single-preview",
        name: "Single Preview",
        preview: { light: "/plugins/demo/only-light.webp" },
        applies: {},
      },
    })

    render(<ThemePackTab />)
    expect(screen.getByTestId("theme-pack-preview-single-preview")).toHaveAttribute(
      "src",
      "/plugins/demo/only-light.webp"
    )
  })

  it("falls back to the dark preview while the app uses light mode", () => {
    resolvedTheme = "light"
    registerThemePack({
      pluginId: "demo",
      pack: {
        id: "dark-only-preview",
        name: "Dark-only Preview",
        preview: { dark: "/plugins/demo/only-dark.webp" },
        applies: {},
      },
    })

    render(<ThemePackTab />)
    expect(screen.getByTestId("theme-pack-preview-dark-only-preview")).toHaveAttribute(
      "src",
      "/plugins/demo/only-dark.webp"
    )
  })

  it("never fetches a preview the plugin points off this machine", () => {
    // Opening the tab must not become a beacon. The card draws without an
    // image rather than asking a host the user never chose.
    registerThemePack({
      pluginId: "demo",
      pack: {
        id: "phoning-home",
        name: "Phoning Home",
        preview: { dark: "https://tracker.example/p.png", light: "/plugins/other/p.png" },
        applies: {},
      },
    })

    render(<ThemePackTab />)
    expect(screen.getByText("Phoning Home")).toBeInTheDocument()
    expect(screen.queryByTestId("theme-pack-preview-phoning-home")).toBeNull()
  })
})
