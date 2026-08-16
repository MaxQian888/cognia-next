/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"

if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("@/lib/appearance", () => ({
  withBuiltinPresets: jest.fn(),
  saveImage: jest.fn(),
  deleteImage: jest.fn(),
  makeWallpaper: jest.fn((args) => ({
    id: args.id,
    name: args.name,
    kind: args.source.kind,
    builtin: false,
    createdAt: 1,
    source: args.source,
  })),
}))
jest.mock("@/lib/appearance/image-utils", () => ({
  readImageDimensions: jest.fn().mockResolvedValue({ width: 1, height: 1 }),
}))
// The generator samples on mount; keep the tab's own tests off the canvas path
// so they control whether a measured analysis exists.
jest.mock("@/lib/appearance/wallpaper-theme-generator", () => ({
  analyzeWallpaperSource: jest.fn(),
  buildWallpaperTheme: jest.fn(),
  recommendBackgroundTuning: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appearance = require("@/lib/appearance") as {
  withBuiltinPresets: jest.Mock
  saveImage: jest.Mock
  deleteImage: jest.Mock
  makeWallpaper: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const themeGenerator = require("@/lib/appearance/wallpaper-theme-generator") as {
  analyzeWallpaperSource: jest.Mock
  buildWallpaperTheme: jest.Mock
  recommendBackgroundTuning: jest.Mock
}

/** A file the real intake accepts, so drop/pick tests exercise validation. */
function pngFile(name: string): File {
  return new File([new Uint8Array([1, 2])], name, { type: "image/png" })
}

const setBackground = jest.fn()
const addWallpaper = jest.fn()
const deleteWallpaper = jest.fn()
const setActiveWallpaper = jest.fn()
const storeState: {
  background: BackgroundSettings
  wallpapers: Wallpaper[]
} = {
  background: { ...DEFAULT_BACKGROUND_SETTINGS },
  wallpapers: [],
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      background: storeState.background,
      wallpapers: storeState.wallpapers,
      setBackground,
      addWallpaper,
      deleteWallpaper,
      setActiveWallpaper,
    })
  ),
}))

// resolveSourceToCss is invoked by the WallpaperCard child; stub it.
jest.mock("@/lib/appearance/wallpaper-storage", () => {
  const actual = jest.requireActual("@/lib/appearance/wallpaper-storage")
  return {
    ...actual,
    resolveSourceToCss: jest.fn().mockResolvedValue("#abcdef"),
    disposeUrl: jest.fn(),
  }
})

import { WallpaperTab } from "./wallpaper-tab"
import {
  applyPluginWallpapers,
  __resetPluginWallpapersForTesting,
} from "@/lib/plugin/bridge/wallpaper-bridge"

/** The analysis the sampler would return for a flat, fully readable field. */
const FLAT_ANALYSIS = {
  accent: "#abcdef",
  secondary: "#efcdab",
  dominant: "#ffffff",
  averageLuminance: 0.95,
  luminanceSpread: 0,
  baseVariant: "light" as const,
}

beforeEach(() => {
  jest.clearAllMocks()
  storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS }
  storeState.wallpapers = []
  __resetPluginWallpapersForTesting()
  // Re-seeded per test: `clearAllMocks` wipes calls but keeps implementations,
  // so a suite that swaps the gallery would otherwise leak into the next one.
  appearance.withBuiltinPresets.mockImplementation((arr: Wallpaper[] | undefined) => [
    {
      id: "preset-mock",
      name: "Mock Preset",
      kind: "color",
      builtin: true,
      createdAt: 0,
      source: { kind: "color", value: "#abcdef" },
    },
    ...(arr ?? []),
  ])
  // Default: sampling fails, so the readability chip falls back to its blind
  // estimate. Tests that care about the measured path opt in explicitly.
  themeGenerator.analyzeWallpaperSource.mockRejectedValue(new Error("unsampled"))
  themeGenerator.recommendBackgroundTuning.mockReturnValue({ opacity: 0.5, blurPx: 4 })
  setBackground.mockResolvedValue(undefined)
})

/** Every `role="radio"` inside the scope picker specifically. */
function scopeRadios() {
  return within(screen.getByTestId("wallpaper-scope-group")).getAllByRole("radio")
}

describe("WallpaperTab", () => {
  it("toggles enabled via setBackground", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    fireEvent.click(screen.getByLabelText("enabledLabel"))
    expect(setBackground).toHaveBeenCalledWith({ enabled: true })
  })

  it("activates a built-in preset on click", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    fireEvent.click(screen.getByLabelText("Mock Preset"))
    expect(setActiveWallpaper).toHaveBeenCalledWith("preset-mock")
  })

  // Upload and gradient are gallery tiles now, not two permanently-expanded
  // blocks competing with the gallery for vertical space.
  describe("add tiles", () => {
    it("offers both add affordances as gallery tiles", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.getByTestId("wallpaper-add-upload")).toBeInTheDocument()
      expect(screen.getByTestId("wallpaper-add-gradient")).toBeInTheDocument()
    })

    it("keeps the upload surface collapsed until its tile is clicked", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.queryByText("dropHint")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("wallpaper-add-upload"))
      expect(await screen.findByText("dropHint")).toBeInTheDocument()
    })

    it("keeps the gradient builder collapsed until its tile is clicked", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.queryByTestId("gradient-preview")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("wallpaper-add-gradient"))
      expect(await screen.findByTestId("gradient-preview")).toBeInTheDocument()
    })
  })

  it("renders an OK contrast chip for a color wallpaper at low opacity", async () => {
    storeState.background = {
      ...DEFAULT_BACKGROUND_SETTINGS,
      activeId: "preset-mock",
      opacity: 0,
    }
    await act(async () => {
      render(<WallpaperTab />)
    })
    const chip = screen.getByTestId("wallpaper-contrast-chip")
    expect(chip.textContent).toMatch(/^OK\s/)
    // No auto-fix in OK band.
    expect(screen.queryByText("opacity.autoFix")).not.toBeInTheDocument()
    // No warn/fail descriptive text.
    expect(screen.queryByText("opacity.warn")).not.toBeInTheDocument()
    expect(screen.queryByText("opacity.fail")).not.toBeInTheDocument()
  })

  describe("readability verdict", () => {
    /** Swap the gallery for a single image wallpaper and render at `opacity`. */
    async function renderWithImage(opacity: number) {
      appearance.withBuiltinPresets.mockImplementation((arr: Wallpaper[] | undefined) => [
        {
          id: "img-mock",
          name: "Image Mock",
          kind: "image",
          builtin: true,
          createdAt: 0,
          source: {
            kind: "image",
            storage: "data-url",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            mime: "image/png",
            width: 1,
            height: 1,
          },
        },
        ...(arr ?? []),
      ])
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "img-mock", opacity }
      await act(async () => {
        render(<WallpaperTab />)
      })
    }

    it("flips to FAIL on an unsampled image at high opacity", async () => {
      await renderWithImage(0.95)

      const chip = screen.getByTestId("wallpaper-contrast-chip")
      expect(chip.textContent).toMatch(/^FAIL\s/)
      expect(chip).toHaveAttribute("data-measured", "false")
      expect(screen.getByText("opacity.estimated")).toBeInTheDocument()
      expect(screen.getByTestId("wallpaper-theme-generator")).toBeInTheDocument()
      expect(screen.getByText("opacity.fail")).toBeInTheDocument()
    })

    // Between AA-large (3:1) and AA-normal (4.5:1): readable at heading size,
    // not at body size.
    it("warns in the band between the two AA thresholds", async () => {
      await renderWithImage(0.87)

      const chip = screen.getByTestId("wallpaper-contrast-chip")
      expect(chip.textContent).toMatch(/^WARN\s/)
      expect(screen.getByText("opacity.warn")).toBeInTheDocument()
      expect(screen.queryByText("opacity.fail")).not.toBeInTheDocument()
      expect(screen.getByText("opacity.autoFix")).toBeInTheDocument()
    })

    // The old auto-fix hardcoded 0.4 no matter how bad (or fine) the wallpaper
    // was; now it solves for the most opacity that still clears AA.
    it("auto-fix applies the highest opacity that still clears AA", async () => {
      await renderWithImage(0.95)

      fireEvent.click(screen.getByText("opacity.autoFix"))

      const applied = setBackground.mock.calls.at(-1)?.[0].opacity as number
      // Black-on-white theme (jsdom default) against the blind 1.5:1 floor.
      expect(applied).toBeCloseTo(0.84, 2)
      expect(document.body.style.getPropertyValue("--app-bg-opacity")).toBe(String(applied))
    })

    it("trusts the sampled wallpaper over the blind estimate once it arrives", async () => {
      themeGenerator.analyzeWallpaperSource.mockResolvedValue(FLAT_ANALYSIS)
      await renderWithImage(0.95)

      const chip = await screen.findByTestId("wallpaper-contrast-chip")
      await waitFor(() => expect(chip).toHaveAttribute("data-measured", "true"))
      expect(chip.textContent).toMatch(/^OK\s/)
      expect(screen.getByText("opacity.measured")).toBeInTheDocument()
      expect(screen.queryByText("opacity.autoFix")).not.toBeInTheDocument()
    })

    // A measurement belongs to one wallpaper. Carrying it across a switch
    // would report the previous image's contrast for the new one.
    it("drops the measurement when the active wallpaper changes", async () => {
      themeGenerator.analyzeWallpaperSource.mockResolvedValue(FLAT_ANALYSIS)
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(<WallpaperTab />)
      })
      // `preset-mock` is a color wallpaper, so its sample resolves immediately.
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "preset-mock" }
      await act(async () => {
        view!.rerender(<WallpaperTab />)
      })
      await waitFor(() =>
        expect(screen.getByTestId("wallpaper-contrast-chip")).toHaveAttribute(
          "data-measured",
          "true"
        )
      )

      // Switch to a second wallpaper whose sample never resolves: nothing can
      // replace the stale reading, so only the id tagging can clear it.
      themeGenerator.analyzeWallpaperSource.mockReturnValue(new Promise(() => {}))
      storeState.wallpapers = [
        {
          id: "user-1",
          name: "User One",
          kind: "gradient",
          builtin: false,
          createdAt: 2,
          source: { kind: "gradient", css: "linear-gradient(#000,#fff)" },
        },
      ]
      storeState.background = { ...storeState.background, activeId: "user-1" }
      await act(async () => {
        view!.rerender(<WallpaperTab />)
      })

      expect(screen.getByTestId("wallpaper-contrast-chip")).toHaveAttribute(
        "data-measured",
        "false"
      )
    })

    it("applies the sampler's suggested opacity and blur in one action", async () => {
      themeGenerator.analyzeWallpaperSource.mockResolvedValue(FLAT_ANALYSIS)
      await renderWithImage(0.95)

      const apply = await screen.findByTestId("wallpaper-apply-tuning")
      fireEvent.click(apply)

      expect(setBackground).toHaveBeenCalledWith({ opacity: 0.5, blurPx: 4 })
      expect(document.body.style.getPropertyValue("--app-bg-opacity")).toBe("0.5")
      expect(document.body.style.getPropertyValue("--app-bg-blur")).toBe("4px")
    })
  })

  describe("scope chips", () => {
    // Every chip lives inside the adjustments fieldset, which is disabled
    // until a wallpaper is active. jsdom's fireEvent dispatches straight at
    // the node and ignores that, so a test without an active wallpaper would
    // pass here while the chip is unclickable in a real browser. Seed one.
    beforeEach(() => {
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "preset-mock" }
    })

    it("renders 5 scope chips with role=radio", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(scopeRadios()).toHaveLength(5)
    })

    // A radiogroup is one tab stop the arrow keys move within, not five.
    it("keeps a single tab stop on the checked chip", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const tabbable = scopeRadios().filter((el) => el.getAttribute("tabindex") === "0")
      expect(tabbable).toHaveLength(1)
      expect(tabbable[0]).toHaveAttribute("data-testid", "wallpaper-scope-all")
    })

    it("moves the selection with the arrow keys", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const all = screen.getByTestId("wallpaper-scope-all")

      fireEvent.keyDown(all, { key: "ArrowRight" })
      expect(setBackground).toHaveBeenLastCalledWith({ scope: "global" })

      // ...and wraps backwards off the first chip to the last.
      fireEvent.keyDown(all, { key: "ArrowLeft" })
      expect(setBackground).toHaveBeenLastCalledWith({ scope: "sidebar" })
    })

    it("ignores keys that are not arrows", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      fireEvent.keyDown(screen.getByTestId("wallpaper-scope-all"), { key: "a" })
      expect(setBackground).not.toHaveBeenCalled()
    })

    it("clicking a scope chip calls setBackground({ scope })", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      fireEvent.click(screen.getByTestId("wallpaper-scope-chat"))
      expect(setBackground).toHaveBeenCalledWith(expect.objectContaining({ scope: "chat" }))
    })

    it("hovering a scope chip sets data-bg-preview on <html>; mouseLeave clears it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const chip = screen.getByTestId("wallpaper-scope-sidebar")
      fireEvent.mouseEnter(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBe("sidebar")
      fireEvent.mouseLeave(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
    })

    it("focus on a scope chip sets data-bg-preview; blur clears it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const chip = screen.getByTestId("wallpaper-scope-canvas")
      fireEvent.focus(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBe("canvas")
      fireEvent.blur(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
    })

    it("marks the active scope chip with aria-checked=true", async () => {
      storeState.background = {
        ...DEFAULT_BACKGROUND_SETTINGS,
        activeId: "preset-mock",
        scope: "global",
      }
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.getByTestId("wallpaper-scope-global")).toHaveAttribute("aria-checked", "true")
      expect(screen.getByTestId("wallpaper-scope-chat")).toHaveAttribute("aria-checked", "false")
    })

    // The nav unmounts this panel on switch; a pinned attribute would survive
    // the rest of the session.
    it("clears data-bg-preview when the panel unmounts mid-hover", async () => {
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(<WallpaperTab />)
      })
      fireEvent.mouseEnter(screen.getByTestId("wallpaper-scope-chat"))
      expect(document.documentElement.getAttribute("data-bg-preview")).toBe("chat")
      view!.unmount()
      expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
    })
  })

  describe("focal point", () => {
    beforeEach(() => {
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "preset-mock" }
    })

    it("offers a 3x3 anchor grid with the stored point checked", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const grid = screen.getByTestId("wallpaper-focal-group")
      expect(within(grid).getAllByRole("radio")).toHaveLength(9)
      expect(screen.getByTestId("wallpaper-focal-center")).toHaveAttribute("aria-checked", "true")
    })

    it("persists both coordinates when a cell is picked", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      fireEvent.click(screen.getByTestId("wallpaper-focal-bottomRight"))
      expect(setBackground).toHaveBeenCalledWith({ focalX: 100, focalY: 100 })
    })

    // `fill` stretches and `tile` repeats — neither leaves the image anywhere
    // to move, so the grid says so instead of silently doing nothing.
    it("disables the grid for fits that cannot honour an anchor", async () => {
      storeState.background = {
        ...DEFAULT_BACKGROUND_SETTINGS,
        activeId: "preset-mock",
        position: "fill",
      }
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.getByTestId("wallpaper-focal-group")).toHaveAttribute("aria-disabled", "true")
      expect(screen.getByTestId("wallpaper-focal-center")).toBeDisabled()
      expect(screen.getByText("focalUnavailable")).toBeInTheDocument()
    })

    it("marks no cell for a focal point between the presets", async () => {
      storeState.background = {
        ...DEFAULT_BACKGROUND_SETTINGS,
        activeId: "preset-mock",
        focalX: 30,
        focalY: 70,
      }
      await act(async () => {
        render(<WallpaperTab />)
      })
      const grid = screen.getByTestId("wallpaper-focal-group")
      for (const cell of within(grid).getAllByRole("radio")) {
        expect(cell).toHaveAttribute("aria-checked", "false")
      }
      expect(screen.getByText("30% · 70%")).toBeInTheDocument()
    })
  })

  describe("slider commits", () => {
    beforeEach(() => {
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "preset-mock" }
    })

    // Persisting every pointer move would write Dexie ~100 times per gesture.
    it("paints the CSS variable while dragging and persists only on release", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      // Radix puts the aria-label on both the root and the thumb; the thumb is
      // the one that carries role="slider" and handles the keyboard.
      const opacity = screen
        .getAllByRole("slider")
        .find((el) => el.getAttribute("aria-label") === "opacityLabel")!

      fireEvent.keyDown(opacity, { key: "ArrowLeft" })
      await waitFor(() =>
        expect(document.body.style.getPropertyValue("--app-bg-opacity")).toBe("0.99")
      )
      expect(setBackground).toHaveBeenCalledWith({ opacity: 0.99 })
    })

    it("previews and commits the blur slider the same way", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const blur = screen
        .getAllByRole("slider")
        .find((el) => el.getAttribute("aria-label") === "blurLabel")!

      fireEvent.keyDown(blur, { key: "ArrowRight" })

      await waitFor(() => expect(document.body.style.getPropertyValue("--app-bg-blur")).toBe("1px"))
      expect(setBackground).toHaveBeenCalledWith({ blurPx: 1 })
    })

    it("restores the persisted values if the panel unmounts mid-drag", async () => {
      storeState.background = {
        ...DEFAULT_BACKGROUND_SETTINGS,
        activeId: "preset-mock",
        opacity: 0.6,
        blurPx: 12,
      }
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(<WallpaperTab />)
      })
      document.body.style.setProperty("--app-bg-opacity", "0.1")
      document.body.style.setProperty("--app-bg-blur", "30px")

      await act(async () => {
        view!.unmount()
      })

      expect(document.body.style.getPropertyValue("--app-bg-opacity")).toBe("0.6")
      expect(document.body.style.getPropertyValue("--app-bg-blur")).toBe("12px")
    })
  })

  describe("adjustments gating", () => {
    it("disables every adjustment while no wallpaper is active", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.getByTestId("wallpaper-adjustments")).toBeDisabled()
      expect(screen.getByText("noActive")).toBeInTheDocument()
      // fieldset does not disable a Radix slider (it renders role=slider, not
      // a form control), so the sliders must carry it themselves.
      for (const slider of screen.getAllByRole("slider")) {
        expect(slider).toHaveAttribute("data-disabled")
      }
    })

    it("enables them once something is selected", async () => {
      storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "preset-mock" }
      await act(async () => {
        render(<WallpaperTab />)
      })
      expect(screen.getByTestId("wallpaper-adjustments")).not.toBeDisabled()
      expect(screen.queryByText("noActive")).not.toBeInTheDocument()
      for (const slider of screen.getAllByRole("slider")) {
        expect(slider).not.toHaveAttribute("data-disabled")
      }
    })
  })

  it("merges plugin-contributed wallpapers into the gallery with a Plugin badge", async () => {
    applyPluginWallpapers({
      pluginId: "demo",
      pluginRoot: "/p/demo",
      resolveAsset: () => "",
      wallpapers: [
        {
          id: "aurora",
          name: "Aurora",
          source: { kind: "gradient", css: "linear-gradient(#000,#fff)" },
        },
      ],
    })
    await act(async () => {
      render(<WallpaperTab />)
    })
    expect(screen.getByLabelText("Aurora")).toBeInTheDocument()
    expect(screen.getByText("pluginBadge")).toBeInTheDocument()
  })

  it("activating a plugin wallpaper calls setActiveWallpaper with its namespaced id", async () => {
    applyPluginWallpapers({
      pluginId: "demo",
      pluginRoot: "/p/demo",
      resolveAsset: () => "",
      wallpapers: [{ id: "aurora", name: "Aurora", source: { kind: "color", value: "#102030" } }],
    })
    await act(async () => {
      render(<WallpaperTab />)
    })
    fireEvent.click(screen.getByLabelText("Aurora"))
    expect(setActiveWallpaper).toHaveBeenCalledWith("plugin-demo-aurora")
  })

  describe("adding a wallpaper", () => {
    beforeEach(() => {
      appearance.saveImage.mockResolvedValue({
        source: {
          kind: "image",
          storage: "indexeddb",
          blobKey: "id-x",
          mime: "image/png",
          width: 1,
          height: 1,
        },
        previewUrl: "blob:mock",
      })
    })

    it("uploads via the picker: saveImage → addWallpaper → setActiveWallpaper", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      // The picker's input only mounts once the tile's popover opens.
      fireEvent.click(screen.getByTestId("wallpaper-add-upload"))
      await screen.findByTestId("wallpaper-uploader")
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile("name.png")] } })
      })
      await waitFor(() => expect(appearance.saveImage).toHaveBeenCalled())
      await waitFor(() => expect(addWallpaper).toHaveBeenCalled())
      await waitFor(() => expect(setActiveWallpaper).toHaveBeenCalled())
    })

    it("accepts a file dropped anywhere on the gallery", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      await act(async () => {
        fireEvent.drop(screen.getByTestId("wallpaper-gallery-dropzone"), {
          dataTransfer: { files: [pngFile("dropped.png")] },
        })
      })
      await waitFor(() => expect(appearance.saveImage).toHaveBeenCalled())
      await waitFor(() => expect(setActiveWallpaper).toHaveBeenCalled())
    })

    it("highlights the gallery while a file is dragged over it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const zone = screen.getByTestId("wallpaper-gallery-dropzone")
      expect(zone).toHaveAttribute("data-drag-over", "false")
      fireEvent.dragOver(zone)
      expect(zone).toHaveAttribute("data-drag-over", "true")
      fireEvent.dragLeave(zone)
      expect(zone).toHaveAttribute("data-drag-over", "false")
    })

    it("surfaces the storage error when saving an accepted file fails", async () => {
      appearance.saveImage.mockRejectedValue(new Error("disk full"))
      await act(async () => {
        render(<WallpaperTab />)
      })
      await act(async () => {
        fireEvent.drop(screen.getByTestId("wallpaper-gallery-dropzone"), {
          dataTransfer: { files: [pngFile("dropped.png")] },
        })
      })
      expect(await screen.findByText("disk full")).toBeInTheDocument()
      expect(setActiveWallpaper).not.toHaveBeenCalled()
    })

    it("saves a built gradient and activates it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      fireEvent.click(screen.getByTestId("wallpaper-add-gradient"))
      await screen.findByTestId("gradient-preview")

      fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
        target: { value: "Dusk" },
      })
      await act(async () => {
        fireEvent.click(screen.getByText("save"))
      })

      expect(addWallpaper).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Dusk", kind: "gradient" })
      )
      expect(setActiveWallpaper).toHaveBeenCalled()
    })

    it("deletes a user wallpaper's bytes before its row", async () => {
      storeState.wallpapers = [
        {
          id: "user-1",
          name: "User One",
          kind: "gradient",
          builtin: false,
          createdAt: 2,
          source: { kind: "gradient", css: "linear-gradient(#000,#fff)" },
        },
      ]
      await act(async () => {
        render(<WallpaperTab />)
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId("wallpaper-delete-button"))
      })

      expect(appearance.deleteImage).toHaveBeenCalledWith({
        kind: "gradient",
        css: "linear-gradient(#000,#fff)",
      })
      expect(deleteWallpaper).toHaveBeenCalledWith("user-1")
    })

    it("surfaces a rejection instead of saving an unsupported drop", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const bad = new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" })
      await act(async () => {
        fireEvent.drop(screen.getByTestId("wallpaper-gallery-dropzone"), {
          dataTransfer: { files: [bad] },
        })
      })
      expect(await screen.findByText("invalidType")).toBeInTheDocument()
      expect(appearance.saveImage).not.toHaveBeenCalled()
    })
  })
})
