/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))
jest.mock("@/lib/appearance/wallpaper-storage", () => ({
  resolveSourceToCss: jest.fn(),
  disposeUrl: jest.fn(),
}))
// The tile decides "can this device open it?" from the runtime marker, so the
// suite drives that marker rather than the real Tauri detection.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauri = require("@/lib/tauri") as { isTauri: jest.Mock }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require("@/lib/appearance/wallpaper-storage") as {
  resolveSourceToCss: jest.Mock
  disposeUrl: jest.Mock
}

import { WallpaperCard } from "./wallpaper-card"
import type { Wallpaper } from "@/types/appearance"

const baseWp = (overrides: Partial<Wallpaper> = {}): Wallpaper => ({
  id: "wp-1",
  name: "Sunset",
  kind: "gradient",
  builtin: false,
  createdAt: 1,
  source: { kind: "gradient", css: "linear-gradient(0deg, red, blue)" },
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  storage.resolveSourceToCss.mockResolvedValue("linear-gradient(0deg, red, blue)")
  tauri.isTauri.mockReturnValue(false)
})

const diskWp = (): Wallpaper =>
  baseWp({
    kind: "image",
    source: {
      kind: "image",
      storage: "disk",
      relPath: "shot.png",
      mime: "image/png",
      width: 4,
      height: 3,
    },
  })

const idbWp = (): Wallpaper =>
  baseWp({
    kind: "image",
    source: {
      kind: "image",
      storage: "indexeddb",
      blobKey: "blob-1",
      mime: "image/png",
      width: 4,
      height: 3,
    },
  })

describe("WallpaperCard", () => {
  it("renders the wallpaper name and triggers onActivate", async () => {
    const onActivate = jest.fn()
    await act(async () => {
      render(<WallpaperCard wallpaper={baseWp()} active={false} onActivate={onActivate} />)
    })
    expect(screen.getByText("Sunset")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Sunset"))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("shows the check icon when active", async () => {
    await act(async () => {
      render(<WallpaperCard wallpaper={baseWp()} active onActivate={() => {}} />)
    })
    const button = screen.getByLabelText("Sunset")
    expect(button.getAttribute("aria-pressed")).toBe("true")
  })

  it("hides the delete button for built-in wallpapers", async () => {
    await act(async () => {
      render(
        <WallpaperCard
          wallpaper={baseWp({ builtin: true })}
          active={false}
          onActivate={() => {}}
          onDelete={() => {}}
        />
      )
    })
    expect(screen.queryByTestId("wallpaper-delete-button")).toBeNull()
  })

  it("invokes onDelete when the trash button is clicked, and stops propagation", async () => {
    const onActivate = jest.fn()
    const onDelete = jest.fn()
    await act(async () => {
      render(
        <WallpaperCard
          wallpaper={baseWp()}
          active={false}
          onActivate={onActivate}
          onDelete={onDelete}
        />
      )
    })
    fireEvent.click(screen.getByTestId("wallpaper-delete-button"))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("marks the tile unavailable when resolveSourceToCss rejects", async () => {
    storage.resolveSourceToCss.mockRejectedValue(new Error("nope"))
    await act(async () => {
      render(<WallpaperCard wallpaper={baseWp()} active={false} onActivate={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("wallpaper-card-unavailable")).toBeInTheDocument()
    // The bytes were meant to be here and are not — that is a different
    // sentence from "they live on another device".
    expect(screen.getByRole("button", { name: "aria" })).toHaveAttribute("title", "missing")
  })

  describe("wallpapers that belong to another device", () => {
    // These rows exist because `wallpapers` used to be classified `shared`, so
    // a paired phone and desktop mirrored libraries neither could open. The
    // classification is fixed; the rows already mirrored are not.
    it("refuses to activate a desktop disk wallpaper seen off the desktop", async () => {
      const onActivate = jest.fn()
      await act(async () => {
        render(<WallpaperCard wallpaper={diskWp()} active={false} onActivate={onActivate} />)
      })
      const button = screen.getByRole("button", { name: "aria" })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("title", "savedOnDesktop")
      fireEvent.click(button)
      // Activating is what used to make BackgroundApplier switch the whole
      // background off, so the click must not reach the handler at all.
      expect(onActivate).not.toHaveBeenCalled()
    })

    it("refuses to activate a phone blob wallpaper seen on the desktop", async () => {
      tauri.isTauri.mockReturnValue(true)
      await act(async () => {
        render(<WallpaperCard wallpaper={idbWp()} active={false} onActivate={() => {}} />)
      })
      expect(screen.getByRole("button", { name: "aria" })).toHaveAttribute(
        "title",
        "savedOnAnotherDevice"
      )
    })

    it("never asks the storage layer for bytes it knows are elsewhere", async () => {
      await act(async () => {
        render(<WallpaperCard wallpaper={diskWp()} active={false} onActivate={() => {}} />)
      })
      // The old code let the resolve throw and caught it. On a phone that meant
      // a Tauri `invoke` per foreign tile on every gallery render.
      expect(storage.resolveSourceToCss).not.toHaveBeenCalled()
    })

    it("keeps delete reachable so the user can tidy the gallery", async () => {
      const onDelete = jest.fn()
      await act(async () => {
        render(
          <WallpaperCard
            wallpaper={diskWp()}
            active={false}
            onActivate={() => {}}
            onDelete={onDelete}
          />
        )
      })
      fireEvent.click(screen.getByTestId("wallpaper-delete-button"))
      expect(onDelete).toHaveBeenCalledTimes(1)
    })

    it("opens the same wallpaper normally on the device that saved it", async () => {
      tauri.isTauri.mockReturnValue(true)
      const onActivate = jest.fn()
      await act(async () => {
        render(<WallpaperCard wallpaper={diskWp()} active={false} onActivate={onActivate} />)
      })
      expect(screen.queryByTestId("wallpaper-card-unavailable")).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Sunset" }))
      expect(onActivate).toHaveBeenCalledTimes(1)
    })
  })

  describe("fit preview", () => {
    const imageWp = baseWp({
      kind: "image",
      source: {
        kind: "image",
        storage: "data-url",
        dataUrl: "data:image/png;base64,AA==",
        mime: "image/png",
        width: 4,
        height: 3,
      },
    })

    it("defaults to a neutral cover thumbnail", async () => {
      await act(async () => {
        render(<WallpaperCard wallpaper={imageWp} active={false} onActivate={() => {}} />)
      })
      expect(screen.getByTestId("wallpaper-card-preview")).toHaveStyle({
        backgroundSize: "cover",
        backgroundPosition: "center",
      })
    })

    // The active tile answers "what does contain / this focal point look like?"
    // without making the user hunt for the live app behind the settings pane.
    it("mirrors the active fit and focal point", async () => {
      await act(async () => {
        render(
          <WallpaperCard
            wallpaper={imageWp}
            active
            onActivate={() => {}}
            previewFit={{ position: "contain", focalX: 0, focalY: 100 }}
          />
        )
      })
      expect(screen.getByTestId("wallpaper-card-preview")).toHaveStyle({
        backgroundSize: "contain",
        backgroundPosition: "0% 100%",
        backgroundRepeat: "no-repeat",
      })
    })

    it("ignores the fit for sources that have no raster to place", async () => {
      await act(async () => {
        render(
          <WallpaperCard
            wallpaper={baseWp()}
            active
            onActivate={() => {}}
            previewFit={{ position: "tile" }}
          />
        )
      })
      expect(screen.getByTestId("wallpaper-card-preview")).toHaveStyle({
        backgroundPosition: "center",
      })
    })
  })

  it("disposes the previously-resolved URL on unmount", async () => {
    storage.resolveSourceToCss.mockResolvedValue("url('blob:mock')")
    const { unmount } = render(
      <WallpaperCard wallpaper={baseWp()} active={false} onActivate={() => {}} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    expect(storage.disposeUrl).toHaveBeenCalledWith("url('blob:mock')")
  })
})
