/**
 * @jest-environment jsdom
 */
import type { WallpaperSource } from "@/types/appearance"

jest.mock("./wallpaper-storage", () => ({
  resolveSourceToCss: jest.fn(),
  disposeUrl: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require("./wallpaper-storage") as {
  resolveSourceToCss: jest.Mock
  disposeUrl: jest.Mock
}

import { analyzeWallpaperSource } from "./wallpaper-theme-generator"

const source: Extract<WallpaperSource, { kind: "image" }> = {
  kind: "image",
  storage: "data-url",
  dataUrl: "data:image/png;base64,AA==",
  mime: "image/png",
  width: 1600,
  height: 900,
}

function installImageMock(options: { fail?: boolean; width?: number; height?: number } = {}) {
  const original = globalThis.Image
  class FakeImage {
    naturalWidth = options.width ?? 480
    naturalHeight = options.height ?? 240
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => (options.fail ? this.onerror?.() : this.onload?.()))
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image
  return () => {
    globalThis.Image = original
  }
}

function installCanvasMock(color: [number, number, number, number]) {
  const getContext = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      const data = new Uint8ClampedArray(this.width * this.height * 4)
      for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset)
      return {
        drawImage: jest.fn(),
        getImageData: jest.fn(() => ({ data })),
      } as unknown as CanvasRenderingContext2D
    } as never)
  return () => getContext.mockRestore()
}

beforeEach(() => {
  jest.clearAllMocks()
  storage.resolveSourceToCss.mockResolvedValue("url('data:image/png;base64,AA==')")
})

describe("analyzeWallpaperSource", () => {
  it("decodes, downsamples, analyzes, and releases the resolved source", async () => {
    const restoreImage = installImageMock()
    const restoreCanvas = installCanvasMock([220, 60, 80, 255])

    await expect(analyzeWallpaperSource(source)).resolves.toMatchObject({
      accent: "#dc3c50",
      baseVariant: "dark",
    })
    expect(storage.disposeUrl).toHaveBeenCalledWith("url('data:image/png;base64,AA==')")

    restoreCanvas()
    restoreImage()
  })

  it("releases an object URL when image decoding fails", async () => {
    const restoreImage = installImageMock({ fail: true })

    await expect(analyzeWallpaperSource(source)).rejects.toThrow(
      "wallpaper image could not be decoded"
    )
    expect(storage.disposeUrl).toHaveBeenCalled()

    restoreImage()
  })

  it("rejects a non-url resolver result without leaking it", async () => {
    storage.resolveSourceToCss.mockResolvedValueOnce("#fff")

    await expect(analyzeWallpaperSource(source)).rejects.toThrow(
      "wallpaper source is not an image URL"
    )
    expect(storage.disposeUrl).toHaveBeenCalledWith("#fff")
  })
})
