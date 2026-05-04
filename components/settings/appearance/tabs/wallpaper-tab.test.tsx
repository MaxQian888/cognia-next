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

beforeEach(() => {
  jest.clearAllMocks()
  storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS }
  storeState.wallpapers = []
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

  it("renders the upload + gradient sections", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    expect(screen.getByText("dropHint")).toBeInTheDocument()
    expect(screen.getByText("gradient.title")).toBeInTheDocument()
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

  it("renders 5 scope cards with role=radio", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    const cards = screen.getAllByRole("radio")
    expect(cards.length).toBe(5)
  })

  it("clicking a scope card calls setBackground({ scope })", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    fireEvent.click(screen.getByRole("radio", { name: /scope\.chat\.label/i }))
    expect(setBackground).toHaveBeenCalledWith(expect.objectContaining({ scope: "chat" }))
  })

  it("hovering a scope card sets data-bg-preview on <html>; mouseLeave clears it", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    const card = screen.getByRole("radio", { name: /scope\.sidebar\.label/i })
    fireEvent.mouseEnter(card)
    expect(document.documentElement.getAttribute("data-bg-preview")).toBe("sidebar")
    fireEvent.mouseLeave(card)
    expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
  })

  it("focus on a scope card sets data-bg-preview; blur clears it", async () => {
    await act(async () => {
      render(<WallpaperTab />)
    })
    const card = screen.getByRole("radio", { name: /scope\.canvas\.label/i })
    fireEvent.focus(card)
    expect(document.documentElement.getAttribute("data-bg-preview")).toBe("canvas")
    fireEvent.blur(card)
    expect(document.documentElement.getAttribute("data-bg-preview")).toBeNull()
  })

  it("marks the active scope card with aria-checked=true", async () => {
    storeState.background = { ...DEFAULT_BACKGROUND_SETTINGS, scope: "global" }
    await act(async () => {
      render(<WallpaperTab />)
    })
    const active = screen.getByRole("radio", { name: /scope\.global\.label/i })
    expect(active.getAttribute("aria-checked")).toBe("true")
    const other = screen.getByRole("radio", { name: /scope\.chat\.label/i })
    expect(other.getAttribute("aria-checked")).toBe("false")
  })

  it("uploads a file: saveImage → addWallpaper → setActiveWallpaper", async () => {
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
    await act(async () => {
      render(<WallpaperTab />)
    })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2])], "name.png", { type: "image/png" })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(appearance.saveImage).toHaveBeenCalled())
    await waitFor(() => expect(addWallpaper).toHaveBeenCalled())
    await waitFor(() => expect(setActiveWallpaper).toHaveBeenCalled())
  })
})
