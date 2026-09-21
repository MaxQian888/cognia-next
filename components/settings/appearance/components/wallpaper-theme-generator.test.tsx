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
const updateCustomTheme = jest.fn()
const setActiveCustomTheme = jest.fn()
const storeState: {
  customThemes: Array<{ id: string; name: string }>
  activeCustomThemeId: string | null
} = {
  customThemes: [],
  activeCustomThemeId: null,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (state: unknown) => unknown) =>
    selector({
      createCustomTheme,
      updateCustomTheme,
      setActiveCustomTheme,
      customThemes: storeState.customThemes,
      activeCustomThemeId: storeState.activeCustomThemeId,
    })
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
  storeState.customThemes = []
  storeState.activeCustomThemeId = null
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

  it("creates and activates a dual theme, and applies the suggested tuning in the same click", async () => {
    const onApplyTuning = jest.fn()
    await renderGenerator({
      wallpaper: imageWallpaper,
      onApplyTuning,
      currentTuning: { opacity: 1, blurPx: 0 },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(generator.buildWallpaperTheme).toHaveBeenCalledWith("themeName:Sunset", analysis)
    expect(createCustomTheme).toHaveBeenCalledWith(generatedTheme)
    expect(setActiveCustomTheme).toHaveBeenCalledWith("theme-generated")
    // "Generate" is the whole job: the readability suggestion goes on too.
    expect(generator.recommendBackgroundTuning).toHaveBeenCalledWith(analysis, "image")
    expect(onApplyTuning).toHaveBeenCalledWith({ opacity: 0.43, blurPx: 8 })
    expect(screen.getByText("createdWithTuning")).toBeInTheDocument()
  })

  it("reports theme-only when the caller cannot apply tuning", async () => {
    await renderGenerator({ wallpaper: imageWallpaper })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(createCustomTheme).toHaveBeenCalledWith(generatedTheme)
    expect(screen.getByText("created")).toBeInTheDocument()
  })

  it("skips the tuning write when the sliders already sit at the suggestion", async () => {
    const onApplyTuning = jest.fn()
    await renderGenerator({
      wallpaper: imageWallpaper,
      onApplyTuning,
      currentTuning: { opacity: 0.43, blurPx: 8 },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(onApplyTuning).not.toHaveBeenCalled()
    expect(screen.getByText("created")).toBeInTheDocument()
  })

  it("refreshes the previously generated theme instead of stacking a duplicate", async () => {
    storeState.customThemes = [{ id: "theme-existing", name: "themeName:Sunset" }]
    storeState.activeCustomThemeId = "other-theme"
    await renderGenerator({ wallpaper: imageWallpaper })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(updateCustomTheme).toHaveBeenCalledWith("theme-existing", generatedTheme)
    expect(createCustomTheme).not.toHaveBeenCalled()
    expect(setActiveCustomTheme).toHaveBeenCalledWith("theme-existing")
  })

  it("does not re-activate a generated theme that is already active", async () => {
    storeState.customThemes = [{ id: "theme-existing", name: "themeName:Sunset" }]
    storeState.activeCustomThemeId = "theme-existing"
    await renderGenerator({ wallpaper: imageWallpaper })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "action" }))
    })

    expect(updateCustomTheme).toHaveBeenCalledWith("theme-existing", generatedTheme)
    expect(setActiveCustomTheme).not.toHaveBeenCalled()
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
      await renderGenerator({
        wallpaper: imageWallpaper,
        onApplyTuning,
        currentTuning: { opacity: 1, blurPx: 0 },
      })

      await waitFor(() => expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument())
      expect(generator.recommendBackgroundTuning).toHaveBeenCalledWith(analysis, "image")
      // Opacity is surfaced as a percentage, blur as pixels.
      expect(screen.getByText("tuningHint:43,8")).toBeInTheDocument()

      fireEvent.click(screen.getByTestId("wallpaper-apply-tuning"))
      expect(onApplyTuning).toHaveBeenCalledWith({ opacity: 0.43, blurPx: 8 })
    })

    it("shows the suggestion row whenever the live values differ from it", async () => {
      await renderGenerator({
        wallpaper: imageWallpaper,
        onApplyTuning: jest.fn(),
        currentTuning: { opacity: 0.9, blurPx: 0 },
      })

      await waitFor(() => expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument())
    })

    it("hides the row once the live values already match the suggestion", async () => {
      await renderGenerator({
        wallpaper: imageWallpaper,
        onApplyTuning: jest.fn(),
        currentTuning: { opacity: 0.43, blurPx: 8 },
      })

      await waitFor(() => expect(screen.getByLabelText("accent")).toBeInTheDocument())
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()
    })

    it("stays hidden while the apply write is in flight, then resurfaces when values drift", async () => {
      const onApplyTuning = jest.fn()
      const view = await renderGenerator({
        wallpaper: imageWallpaper,
        onApplyTuning,
        currentTuning: { opacity: 1, blurPx: 0 },
      })

      await waitFor(() => expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument())
      await act(async () => {
        fireEvent.click(screen.getByTestId("wallpaper-apply-tuning"))
      })

      // The store write has not landed yet — currentTuning still reads the
      // pre-apply values — but the row must not bounce back.
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()

      const nextProps = {
        wallpaper: imageWallpaper,
        onApplyTuning,
        currentTuning: { opacity: 0.43, blurPx: 8 },
      }
      await act(async () => {
        view.rerender(<WallpaperThemeGenerator {...nextProps} />)
      })
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()

      // Dragging the sliders away from the suggestion brings the row back
      // as a way to snap them back.
      await act(async () => {
        view.rerender(
          <WallpaperThemeGenerator {...nextProps} currentTuning={{ opacity: 0.9, blurPx: 2 }} />
        )
      })
      expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument()
    })

    it("hides the row after generate applied the suggestion", async () => {
      const onApplyTuning = jest.fn()
      const view = await renderGenerator({
        wallpaper: imageWallpaper,
        onApplyTuning,
        currentTuning: { opacity: 1, blurPx: 0 },
      })

      await waitFor(() => expect(screen.getByTestId("wallpaper-apply-tuning")).toBeInTheDocument())
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "action" }))
      })
      expect(onApplyTuning).toHaveBeenCalledWith({ opacity: 0.43, blurPx: 8 })
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()

      // The write lands; the row stays hidden.
      await act(async () => {
        view.rerender(
          <WallpaperThemeGenerator
            wallpaper={imageWallpaper}
            onApplyTuning={onApplyTuning}
            currentTuning={{ opacity: 0.43, blurPx: 8 }}
          />
        )
      })
      expect(screen.queryByTestId("wallpaper-apply-tuning")).not.toBeInTheDocument()
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
