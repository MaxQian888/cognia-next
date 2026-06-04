/**
 * @jest-environment jsdom
 */
import {
  AVATAR_EDGE_PX,
  MAX_AVATAR_BYTES,
  dataUrlByteLength,
  downscaleToDataUrl,
  isAcceptedAvatarType,
} from "./avatar-image"

beforeAll(() => {
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", writable: true })
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, writable: true })
  }
})

const installImageMock = (opts: { fail?: boolean; width?: number; height?: number } = {}) => {
  const original = (globalThis as unknown as { Image: typeof Image }).Image
  class FakeImage {
    public naturalWidth = opts.width ?? 1280
    public naturalHeight = opts.height ?? 720
    public onload: (() => void) | null = null
    public onerror: (() => void) | null = null
    set src(_v: string) {
      Promise.resolve().then(() => {
        if (opts.fail) this.onerror?.()
        else this.onload?.()
      })
    }
  }
  ;(globalThis as unknown as { Image: typeof Image }).Image = FakeImage as unknown as typeof Image
  return () => {
    ;(globalThis as unknown as { Image: typeof Image }).Image = original
  }
}

/** Build a data URL whose base64 payload decodes to ~`bytes` bytes. */
const dataUrlOfBytes = (mime: string, bytes: number) =>
  `data:${mime};base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`

interface CanvasMockOptions {
  /** Per-mime data URL factory; defaults to a tiny payload of that mime. */
  encode?: (mime: string, quality?: number) => string
  /** When true, getContext returns null. */
  noContext?: boolean
}

const installCanvasMock = (opts: CanvasMockOptions = {}) => {
  const drawImage = jest.fn()
  const getContext = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => (opts.noContext ? null : ({ drawImage } as unknown as never)))
  const toDataURL = jest
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation((mime?: string, quality?: unknown) =>
      opts.encode
        ? opts.encode(mime ?? "image/png", quality as number | undefined)
        : dataUrlOfBytes(mime ?? "image/png", 1024)
    )
  return {
    drawImage,
    restore: () => {
      getContext.mockRestore()
      toDataURL.mockRestore()
    },
  }
}

const pngFile = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" })

afterEach(() => {
  jest.restoreAllMocks()
})

describe("isAcceptedAvatarType", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"])(
    "accepts %s",
    (mime) => {
      expect(isAcceptedAvatarType(mime)).toBe(true)
    }
  )

  it.each(["image/svg+xml", "application/pdf", "text/plain", ""])("rejects %s", (mime) => {
    expect(isAcceptedAvatarType(mime)).toBe(false)
  })
})

describe("dataUrlByteLength", () => {
  it("approximates the decoded payload size", () => {
    // 8 base64 chars → 6 bytes.
    expect(dataUrlByteLength("data:image/png;base64,AAAAAAAA")).toBe(6)
  })

  it("treats a comma-less string as pure payload", () => {
    expect(dataUrlByteLength("AAAA")).toBe(3)
  })
})

describe("downscaleToDataUrl", () => {
  it("rejects unsupported file types before decoding", async () => {
    const file = new File([new Uint8Array([1])], "a.svg", { type: "image/svg+xml" })
    await expect(downscaleToDataUrl(file)).rejects.toThrow(/unsupported avatar image type/)
  })

  it("returns a webp data URL when the first attempt fits", async () => {
    const restoreImage = installImageMock()
    const canvas = installCanvasMock()
    const result = await downscaleToDataUrl(pngFile())
    expect(result.startsWith("data:image/webp")).toBe(true)
    expect(dataUrlByteLength(result)).toBeLessThanOrEqual(MAX_AVATAR_BYTES)
    canvas.restore()
    restoreImage()
  })

  it("center-crops the source to a square at the target edge", async () => {
    const restoreImage = installImageMock({ width: 1280, height: 720 })
    const canvas = installCanvasMock()
    await downscaleToDataUrl(pngFile(), 64)
    // crop = min(1280,720) = 720; sx = (1280-720)/2 = 280; sy = 0.
    expect(canvas.drawImage).toHaveBeenCalledWith(expect.anything(), 280, 0, 720, 720, 0, 0, 64, 64)
    canvas.restore()
    restoreImage()
  })

  it("defaults the edge to AVATAR_EDGE_PX", async () => {
    const restoreImage = installImageMock({ width: 300, height: 300 })
    const canvas = installCanvasMock()
    await downscaleToDataUrl(pngFile())
    expect(canvas.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      300,
      300,
      0,
      0,
      AVATAR_EDGE_PX,
      AVATAR_EDGE_PX
    )
    canvas.restore()
    restoreImage()
  })

  it("falls back to jpeg when the encoder ignores webp (PNG fallback browsers)", async () => {
    const restoreImage = installImageMock()
    const canvas = installCanvasMock({
      // Simulate a browser without webp encoding: webp requests come back PNG.
      encode: (mime) =>
        mime === "image/webp" ? dataUrlOfBytes("image/png", 1024) : dataUrlOfBytes(mime, 1024),
    })
    const result = await downscaleToDataUrl(pngFile())
    expect(result.startsWith("data:image/jpeg")).toBe(true)
    canvas.restore()
    restoreImage()
  })

  it("walks quality down until the payload fits the cap", async () => {
    const restoreImage = installImageMock()
    const canvas = installCanvasMock({
      encode: (mime, quality) =>
        mime === "image/webp" && quality === 0.9
          ? dataUrlOfBytes(mime, MAX_AVATAR_BYTES + 4096)
          : dataUrlOfBytes(mime, 2048),
    })
    const result = await downscaleToDataUrl(pngFile())
    expect(result.startsWith("data:image/webp")).toBe(true)
    expect(dataUrlByteLength(result)).toBeLessThanOrEqual(MAX_AVATAR_BYTES)
    canvas.restore()
    restoreImage()
  })

  it("throws when every encoder attempt exceeds the cap", async () => {
    const restoreImage = installImageMock()
    const canvas = installCanvasMock({
      encode: (mime) => dataUrlOfBytes(mime, MAX_AVATAR_BYTES + 4096),
    })
    await expect(downscaleToDataUrl(pngFile())).rejects.toThrow(/too large/)
    canvas.restore()
    restoreImage()
  })

  it("throws when the image fails to decode", async () => {
    const restoreImage = installImageMock({ fail: true })
    await expect(downscaleToDataUrl(pngFile())).rejects.toThrow(/could not decode image/)
    restoreImage()
  })

  it("throws when the decoded image has zero dimensions", async () => {
    const restoreImage = installImageMock({ width: 0, height: 0 })
    await expect(downscaleToDataUrl(pngFile())).rejects.toThrow(/could not decode image/)
    restoreImage()
  })

  it("throws when the canvas 2d context is unavailable", async () => {
    const restoreImage = installImageMock()
    const canvas = installCanvasMock({ noContext: true })
    await expect(downscaleToDataUrl(pngFile())).rejects.toThrow(/context unavailable/)
    canvas.restore()
    restoreImage()
  })
})
