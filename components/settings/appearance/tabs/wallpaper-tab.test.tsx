/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
  withBuiltinPresets: jest.fn((arr: Wallpaper[] | undefined) => [
    {
      id: "preset-mock",
      name: "Mock Preset",
      kind: "color",
      builtin: true,
      createdAt: 0,
      source: { kind: "color", value: "#abcdef" },
    },
    ...(arr ?? []),
  ]),
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appearance = require("@/lib/appearance") as {
  withBuiltinPresets: jest.Mock
  saveImage: jest.Mock
  deleteImage: jest.Mock
  makeWallpaper: jest.Mock
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

beforeEach(() => {
  jest.clearAllMocks()
  storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS }
  storeState.wallpapers = []
  __resetPluginWallpapersForTesting()
})

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

  it("flips to FAIL on an image wallpaper at high opacity and auto-fix lowers it to 0.4", async () => {
    appearance.withBuiltinPresets.mockImplementationOnce((arr: Wallpaper[] | undefined) => [
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
    storeState.background = {
      ...DEFAULT_BACKGROUND_SETTINGS,
      activeId: "img-mock",
      opacity: 0.95,
    }
    await act(async () => {
      render(<WallpaperTab />)
    })
    const chip = screen.getByTestId("wallpaper-contrast-chip")
    expect(chip.textContent).toMatch(/^FAIL\s/)
    expect(screen.getByText("opacity.fail")).toBeInTheDocument()
    fireEvent.click(screen.getByText("opacity.autoFix"))
    expect(setBackground).toHaveBeenCalledWith({ opacity: 0.4 })
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
      expect(screen.getAllByRole("radio")).toHaveLength(5)
    })

    it("clicking a scope chip calls setBackground({ scope })", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      fireEvent.click(screen.getByRole("radio", { name: /scope\.chat\.label/i }))
      expect(setBackground).toHaveBeenCalledWith(expect.objectContaining({ scope: "chat" }))
    })

    it("hovering a scope chip sets data-bg-preview on <html>; mouseLeave clears it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const chip = screen.getByRole("radio", { name: /scope\.sidebar\.label/i })
      fireEvent.mouseEnter(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBe("sidebar")
      fireEvent.mouseLeave(chip)
      expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
    })

    it("focus on a scope chip sets data-bg-preview; blur clears it", async () => {
      await act(async () => {
        render(<WallpaperTab />)
      })
      const chip = screen.getByRole("radio", { name: /scope\.canvas\.label/i })
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
      expect(screen.getByRole("radio", { name: /scope\.global\.label/i })).toHaveAttribute(
        "aria-checked",
        "true"
      )
      expect(screen.getByRole("radio", { name: /scope\.chat\.label/i })).toHaveAttribute(
        "aria-checked",
        "false"
      )
    })

    // The nav unmounts this panel on switch; a pinned attribute would survive
    // the rest of the session.
    it("clears data-bg-preview when the panel unmounts mid-hover", async () => {
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(<WallpaperTab />)
      })
      fireEvent.mouseEnter(screen.getByRole("radio", { name: /scope\.chat\.label/i }))
      expect(document.documentElement.getAttribute("data-bg-preview")).toBe("chat")
      view!.unmount()
      expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
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
