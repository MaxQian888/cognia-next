/**
 * The codec is the engine's only browser dependency, so this suite stands a
 * minimal canvas up in the node environment rather than paying for jsdom, which
 * would not supply a working 2D context anyway. The fake stores pixels as JSON
 * inside the blob, which makes decode and encode a real round trip and lets the
 * interesting behaviour (format choice, media-type honesty, the cross-origin
 * read-back failure) be asserted rather than mocked away.
 */

import {
  canRasterize,
  chooseEncodeFormat,
  decodeUrlToPixelBuffer,
  encodePixelBuffer,
  fromImageData,
  toImageData,
  ImageDecodeError,
  IMAGE_ENCODE_FORMATS,
} from "./codec"
import { createPixelBuffer, type PixelBuffer } from "./pixel-buffer"

interface FakeGlobals {
  ImageData?: unknown
  OffscreenCanvas?: unknown
  createImageBitmap?: unknown
  Image?: unknown
  URL?: unknown
}

const globalRef = globalThis as unknown as FakeGlobals & Record<string, unknown>
const originals: FakeGlobals = {}

/** Blob payload the fake decoder understands. */
function encodePixels(buffer: PixelBuffer): string {
  return JSON.stringify({ w: buffer.width, h: buffer.height, d: [...buffer.data] })
}

class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

/** What `convertToBlob` is told to answer with, so a codec gap can be faked. */
let encodeResponds: (requested: string) => string = (requested) => requested
let readBackThrows: Error | null = null

class FakeContext {
  buffer: PixelBuffer = createPixelBuffer(1, 1)

  drawImage(source: { pixels: PixelBuffer }): void {
    this.buffer = source.pixels
  }

  putImageData(imageData: FakeImageData): void {
    this.buffer = {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    }
  }

  getImageData(_x: number, _y: number, width: number, height: number): FakeImageData {
    if (readBackThrows) throw readBackThrows
    return new FakeImageData(new Uint8ClampedArray(this.buffer.data), width, height)
  }
}

class FakeOffscreenCanvas {
  width: number
  height: number
  private readonly context = new FakeContext()

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): FakeContext {
    return this.context
  }

  async convertToBlob({ type }: { type: string }): Promise<Blob> {
    return new Blob([encodePixels(this.context.buffer)], { type: encodeResponds(type) })
  }
}

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin: string | null = null
  naturalWidth = 0
  naturalHeight = 0
  pixels: PixelBuffer = createPixelBuffer(1, 1)

  set src(value: string) {
    queueMicrotask(() => {
      if (value.includes("broken")) {
        this.onerror?.()
        return
      }
      this.pixels = createPixelBuffer(2, 2)
      this.naturalWidth = 2
      this.naturalHeight = 2
      this.onload?.()
    })
  }
}

beforeEach(() => {
  encodeResponds = (requested) => requested
  readBackThrows = null
  for (const key of ["ImageData", "OffscreenCanvas", "createImageBitmap", "Image"] as const) {
    originals[key] = globalRef[key]
  }
  globalRef.ImageData = FakeImageData
  globalRef.OffscreenCanvas = FakeOffscreenCanvas
  globalRef.Image = FakeImage
  globalRef.createImageBitmap = async (blob: Blob) => {
    const parsed = JSON.parse(await blob.text()) as { w: number; h: number; d: number[] }
    return {
      width: parsed.w,
      height: parsed.h,
      pixels: { data: new Uint8ClampedArray(parsed.d), width: parsed.w, height: parsed.h },
      close: () => {},
    }
  }
})

afterEach(() => {
  for (const key of ["ImageData", "OffscreenCanvas", "createImageBitmap", "Image"] as const) {
    if (originals[key] === undefined) delete globalRef[key]
    else globalRef[key] = originals[key]
  }
})

function opaque(width: number, height: number): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) {
    buffer.data[i] = 10
    buffer.data[i + 1] = 20
    buffer.data[i + 2] = 30
    buffer.data[i + 3] = 255
  }
  return buffer
}

describe("canRasterize", () => {
  it("is true when a canvas implementation exists", () => {
    expect(canRasterize()).toBe(true)
  })

  it("is false in a runtime with neither OffscreenCanvas nor a document", () => {
    delete globalRef.OffscreenCanvas
    expect(canRasterize()).toBe(false)
  })
})

describe("chooseEncodeFormat", () => {
  it("defaults to webp for an opaque frame", () => {
    expect(chooseEncodeFormat(opaque(2, 2))).toBe("webp")
  })

  it("honours an explicit preference", () => {
    expect(chooseEncodeFormat(opaque(2, 2), "jpeg")).toBe("jpeg")
    expect(chooseEncodeFormat(opaque(2, 2), "png")).toBe("png")
  })

  it("overrides the preference to png when the frame carries alpha", () => {
    // Neither jpeg nor webp is chosen for a transparent frame here, because
    // flattening alpha silently is a data loss the user never asked for.
    const transparent = createPixelBuffer(2, 2)
    expect(chooseEncodeFormat(transparent, "jpeg")).toBe("png")
    expect(chooseEncodeFormat(transparent, "webp")).toBe("png")
  })

  it("offers exactly the three formats the download menu lists", () => {
    expect([...IMAGE_ENCODE_FORMATS]).toEqual(["png", "jpeg", "webp"])
  })
})

describe("encodePixelBuffer", () => {
  it("returns the bytes plus the media type", async () => {
    const result = await encodePixelBuffer(opaque(2, 2), { format: "png" })
    expect(result.mediaType).toBe("image/png")
    expect(result.bytes.byteLength).toBeGreaterThan(0)
  })

  it("labels the bytes with what the codec produced, not what was requested", async () => {
    // A runtime with no WebP encoder answers `toBlob("image/webp")` with a PNG.
    // Trusting the request would mislabel those bytes forever in a
    // content-addressed store.
    encodeResponds = () => "image/png"
    const result = await encodePixelBuffer(opaque(2, 2), { format: "webp" })
    expect(result.mediaType).toBe("image/png")
  })

  it("falls back to png when the buffer carries alpha", async () => {
    const result = await encodePixelBuffer(createPixelBuffer(2, 2), { format: "jpeg" })
    expect(result.mediaType).toBe("image/png")
  })
})

describe("decodeUrlToPixelBuffer", () => {
  it("decodes a loadable URL", async () => {
    const buffer = await decodeUrlToPixelBuffer("https://example.com/a.png")
    expect(buffer).toMatchObject({ width: 2, height: 2 })
  })

  it("reports a cross-origin read-back failure as `cors`, not as a broken image", async () => {
    readBackThrows = new DOMException("tainted", "SecurityError")
    await expect(decodeUrlToPixelBuffer("https://example.com/a.png")).rejects.toMatchObject({
      name: "ImageDecodeError",
      reason: "cors",
    })
  })

  it("reports an unloadable URL as a decode failure", async () => {
    await expect(decodeUrlToPixelBuffer("https://example.com/broken.png")).rejects.toMatchObject({
      reason: "decode",
    })
  })

  it("refuses up front when nothing can rasterize", async () => {
    delete globalRef.OffscreenCanvas
    await expect(decodeUrlToPixelBuffer("https://example.com/a.png")).rejects.toMatchObject({
      reason: "unsupported",
    })
  })
})

describe("ImageData interop", () => {
  it("copies out to ImageData and adopts back with no copy", () => {
    const buffer = opaque(2, 1)
    const imageData = toImageData(buffer) as unknown as FakeImageData
    expect(imageData.width).toBe(2)
    expect(imageData.data).not.toBe(buffer.data)

    const adopted = fromImageData(imageData as unknown as ImageData)
    expect(adopted.data).toBe(imageData.data)
  })

  it("refuses when the runtime has no ImageData at all", () => {
    delete globalRef.ImageData
    expect(() => toImageData(opaque(1, 1))).toThrow(ImageDecodeError)
  })
})

describe("pixelBufferToDataUrlSync", () => {
  it("refuses in a runtime with no document rather than returning a broken URL", async () => {
    // Only `HTMLCanvasElement.toDataURL` is synchronous, so a worker or the
    // node environment genuinely cannot serve this call.
    const { pixelBufferToDataUrlSync } = await import("./codec")
    expect(() => pixelBufferToDataUrlSync(opaque(1, 1))).toThrow(ImageDecodeError)
  })
})

describe("encodeProviderMask", () => {
  it("always encodes PNG, whatever the codec would prefer for a photo", async () => {
    const { encodeProviderMask } = await import("./codec")
    const { rasterizeMask } = await import("./mask")
    const mask = rasterizeMask(
      [{ mode: "add", radius: 2, hardness: 1, points: [{ x: 2, y: 2 }] }],
      { width: 4, height: 4 }
    )
    const encoded = await encodeProviderMask(mask)
    expect(encoded.mediaType).toBe("image/png")
    expect(encoded.bytes.byteLength).toBeGreaterThan(0)
  })

  it("inverts on the way out, so the painted region is the transparent one", async () => {
    const { encodeProviderMask } = await import("./codec")
    const { rasterizeMask } = await import("./mask")
    const mask = rasterizeMask(
      [{ mode: "add", radius: 4, hardness: 1, points: [{ x: 1, y: 1 }] }],
      { width: 2, height: 2 }
    )
    const encoded = await encodeProviderMask(mask)
    const parsed = JSON.parse(new TextDecoder().decode(encoded.bytes)) as { d: number[] }
    expect(parsed.d[3]).toBe(0)
  })
})

describe("pixelBufferToDataUrlSync, with a document", () => {
  const originalDocument = (globalThis as { document?: unknown }).document

  afterEach(() => {
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = originalDocument
  })

  it("encodes through the DOM canvas, which is the plugin SDK's contract", async () => {
    // The synchronous signature is published to plugin authors, so its actual
    // encode path needs cover, not just its "no document" refusal.
    let requested: [string, number | undefined] | null = null
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ putImageData: () => {} }),
        toDataURL: (type: string, quality?: number) => {
          requested = [type, quality]
          return `data:${type};base64,AAA`
        },
      }),
    }
    const { pixelBufferToDataUrlSync } = await import("./codec")
    expect(pixelBufferToDataUrlSync(opaque(2, 2), "png")).toBe("data:image/png;base64,AAA")
    // PNG is lossless, so passing a quality would be meaningless.
    expect(requested).toEqual(["image/png", undefined])

    expect(pixelBufferToDataUrlSync(opaque(2, 2), "jpeg", 0.5)).toContain("image/jpeg")
    expect(requested).toEqual(["image/jpeg", 0.5])
  })

  it("refuses when the document has no 2D context", async () => {
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({ getContext: () => null }),
    }
    const { pixelBufferToDataUrlSync } = await import("./codec")
    expect(() => pixelBufferToDataUrlSync(opaque(1, 1))).toThrow(ImageDecodeError)
  })
})
