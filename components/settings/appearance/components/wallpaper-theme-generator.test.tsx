/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Wallpaper } from "@/types/appearance"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { name?: string }) =>
    values?.name ? `${key}:${values.name}` : key,
}))

const analysis = {
  accent: "#f05064",
  averageLuminance: 0.4,
  baseVariant: "dark" as const,
}
const generatedTheme = {
  name: "themeName:Sunset",
  baseVariant: "dark" as const,
  tokens: { light: {}, dark: {} },
}

jest.mock("@/lib/appearance/wallpaper-theme-generator", () => ({
  analyzeWallpaperSource: jest.fn(),
  buildWallpaperTheme: jest.fn(),
}))

const createCustomTheme = jest.fn().mockReturnValue("theme-generated")
const setActiveCustomTheme = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (state: unknown) => unknown) =>
    selector({ createCustomTheme, setActiveCustomTheme })
  ),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const generator = require("@/lib/appearance/wallpaper-theme-generator") as {
  analyzeWallpaperSource: jest.Mock
  buildWallpaperTheme: jest.Mock
}

import { WallpaperThemeGenerator } from "./wallpaper-theme-generator"

const imageWallpaper: Wallpaper = {
  id: "sunset",
  name: "Sunset",
  kind: "image",
  builtin: false,
  createdAt: 1,
  source: {
    kind: "image",
    storage: "data-url",
    dataUrl: "data:image/png;base64,AA==",
    mime: "image/png",
    width: 1600,
    height: 900,
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  generator.analyzeWallpaperSource.mockResolvedValue(analysis)
  generator.buildWallpaperTheme.mockReturnValue(generatedTheme)
  createCustomTheme.mockReturnValue("theme-generated")
})

describe("WallpaperThemeGenerator", () => {
  it("stays hidden when the active wallpaper is not an image", () => {
    const gradient: Wallpaper = {
      ...imageWallpaper,
      kind: "gradient",
      source: { kind: "gradient", css: "linear-gradient(#000,#fff)" },
    }
    const { container } = render(<WallpaperThemeGenerator wallpaper={gradient} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("analyzes the image, creates a dual theme, and activates it", async () => {
    render(<WallpaperThemeGenerator wallpaper={imageWallpaper} />)

    fireEvent.click(screen.getByRole("button", { name: "action" }))

    await waitFor(() => expect(generator.analyzeWallpaperSource).toHaveBeenCalled())
    expect(generator.buildWallpaperTheme).toHaveBeenCalledWith("themeName:Sunset", analysis)
    expect(createCustomTheme).toHaveBeenCalledWith(generatedTheme)
    expect(setActiveCustomTheme).toHaveBeenCalledWith("theme-generated")
    expect(screen.getByText("created")).toBeInTheDocument()
    expect(screen.getByLabelText("accent")).toHaveStyle({ backgroundColor: "#f05064" })
  })

  it("surfaces a localized error when local image analysis fails", async () => {
    generator.analyzeWallpaperSource.mockRejectedValueOnce(new Error("decode failed"))
    render(<WallpaperThemeGenerator wallpaper={imageWallpaper} />)

    fireEvent.click(screen.getByRole("button", { name: "action" }))

    expect(await screen.findByText("error")).toBeInTheDocument()
    expect(createCustomTheme).not.toHaveBeenCalled()
  })
})
