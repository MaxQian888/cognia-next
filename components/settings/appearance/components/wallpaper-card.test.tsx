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
    expect(screen.queryByLabelText(/Delete/)).toBeNull()
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
    fireEvent.click(screen.getByLabelText("Delete Sunset"))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("renders the error sentinel when resolveSourceToCss rejects", async () => {
    storage.resolveSourceToCss.mockRejectedValue(new Error("nope"))
    await act(async () => {
      render(<WallpaperCard wallpaper={baseWp()} active={false} onActivate={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    // Sentinel "!" is the only text inside the error overlay.
    expect(screen.getByText("!")).toBeInTheDocument()
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
