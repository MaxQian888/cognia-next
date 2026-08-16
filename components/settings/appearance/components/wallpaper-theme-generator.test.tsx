/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Wallpaper } from "@/types/appearance"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const analysis = {
  accent: "#f05064",
  secondary: "#50f0dc",
  dominant: "#403038",
  averageLuminance: 0.4,
  luminanceSpread: 0.3,
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
  recommendBackgroundTuning: jest.fn(),
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
  recommendBackgroundTuning: jest.Mock
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

const gradientWallpaper: Wallpaper = {
  ...imageWallpaper,
  id: "aurora",
  name: "Aurora",
  kind: "gradient",
  source: { kind: "gradient", css: "linear-gradient(#000,#fff)" },
}

async function renderGenerator(props: Parameters<typeof WallpaperThemeGenerator>[0]) {
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(<WallpaperThemeGenerator {...props} />)
  })
  return view!
}

beforeEach(() => {
  jest.clearAllMocks()
  generator.analyzeWallpaperSource.mockResolvedValue(analysis)
  generator.buildWallpaperTheme.mockReturnValue(generatedTheme)
  generator.recommendBackgroundTuning.mockReturnValue({ opacity: 0.43, blurPx: 8 })
  createCustomTheme.mockReturnValue("theme-generated")
})

describe("WallpaperThemeGenerator", () => {
  it("renders nothing when no wallpaper is active", async () => {
    const { container } = await renderGenerator({ wallpaper: null })
    expect(container).toBeEmptyDOMElement()
    expect(generator.analyzeWallpaperSource).not.toHaveBeenCalled()
  })

  // Gradient and color wallpapers used to be excluded outright, which hid the
  // feature for every built-in preset.
  it("offers generation for a gradient wallpaper too", async () => {
    await renderGenerator({ wallpaper: gradientWallpaper })

    expect(screen.getByTestId("wallpaper-theme-generator")).toBeInTheDocument()
    await waitFor(() =>
      expect(generator.analyzeWallpaperSource).toHaveBeenCalledWith(gradientWallpaper.source)
    )
  })

  it("samples on mount and reports the analysis upward", async () => {
    const onAnalyzed = jest.fn()
    await renderGenerator({ wallpaper: imageWallpaper, onAnalyzed })

    await waitFor(() => expect(onAnalyzed).toHaveBeenCalledWith(analysis))
    expect(screen.getByLabelText("accent")).toHaveStyle({ backgroundColor: "#f05064" })
    expect(screen.getByLabelText("secondary")).toHaveStyle({ backgroundColor: "#50f0dc" })
    // Sampling alone is not "a theme was created".
    expect(screen.getByText("description")).toBeInTheDocument()
    expect(createCustomTheme).not.toHaveBeenCalled()
  })

  it("reports null upward when the mount-time sample fails", async () => {
    generator.analyzeWallpaperSource.mockRejectedValue(new Error("decode failed"))
    const onAnalyzed = jest.fn()
    await renderGenerator({ wallpaper: imageWallpaper, onAnalyzed })

    await waitFor(() => expect(onAnalyzed).toHaveBeenCalledWith(null))
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  // Both async paths guard on unmount; without the guard React warns and, worse,
  // a stale sample from the previous wallpaper would be reported upward.
  describe("cancellation", () => {
    it.each([
      ["resolves", () => generator.analyzeWallpaperSource.mockResolvedValue(analysis)],
      [
        "rejects",
        () => generator.analyzeWallpaperSource.mockRejectedValue(new Error("decode failed")),
      ],
    ])("reports nothing when the sample %s after unmount", async (_label, arrange) => {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      generator.analyzeWallpaperSource.mockImplementation(async () => {
        await gate
        arrange()
        return generator.analyzeWallpaperSource()
      })
      const onAnalyzed = jest.fn()
      const view = render(
        <WallpaperThemeGenerator wallpaper={imageWallpaper} onAnalyzed={onAnalyzed} />
      )

      view.unmount()
      await act(async () => {
        release!()
        await Promise.resolve()
      })

      expect(onAnalyzed).not.toHaveBeenCalled()
    })
  })

  it("analyzes the image, creates a dual theme, and activates it", async () => {
    await renderGenerator({ wallpaper: imageWallpaper })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(generator.buildWallpaperTheme).toHaveBeenCalledWith("themeName:Sunset", analysis)
    expect(createCustomTheme).toHaveBeenCalledWith(generatedTheme)
    expect(setActiveCustomTheme).toHaveBeenCalledWith("theme-generated")
    expect(screen.getByText("created")).toBeInTheDocument()
  })

  it("surfaces a localized error when local image analysis fails", async () => {
    await renderGenerator({ wallpaper: imageWallpaper })
    generator.analyzeWallpaperSource.mockRejectedValueOnce(new Error("decode failed"))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(await screen.findByText("error")).toBeInTheDocument()
    expect(createCustomTheme).not.toHaveBeenCalled()
  })

  describe("suggested tuning", () => {
    it("hands the sampled opacity and blur back to the caller", async () => {
      const onApplyTuning = jest.fn()
      await renderGenerator({ wallpaper: imageWallpaper, onApplyTuning })

      await waitFor(() => expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument())
      expect(generator.recommendBackgroundTuning).toHaveBeenCalledWith(analysis, "image")
      // Opacity is surfaced as a percentage, blur as pixels.
      expect(screen.getByText("tuningHint:43,8")).toBeInTheDocument()

      fireEvent.click(screen.getByTestId("wallpaper-apply-tuning"))
      expect(onApplyTuning).toHaveBeenCalledWith({ opacity: 0.43, blurPx: 8 })
    })

    it("stays hidden when the caller cannot apply it", async () => {
      await renderGenerator({ wallpaper: imageWallpaper })

      await waitFor(() => expect(screen.getByLabelText("accent")).toBeInTheDocument())
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()
    })

    it("stays hidden while the sample is unavailable", async () => {
      generator.analyzeWallpaperSource.mockRejectedValue(new Error("decode failed"))
      await renderGenerator({ wallpaper: imageWallpaper, onApplyTuning: jest.fn() })

      await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument())
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()
    })
  })
})
