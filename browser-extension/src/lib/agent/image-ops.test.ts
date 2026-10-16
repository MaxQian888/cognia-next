/** @jest-environment node */
import {
  MAX_CANVAS_SIDE,
  blobToBase64,
  createImageOps,
  dataUrlToBlob,
  type Bitmap,
  type ImageSurface,
} from "./image-ops"

/** Bitmaps sized by the data URL's payload, e.g. `data:image/png;base64,` + btoa("800x600"). */
function shot(width: number, height: number): string {
  return `data:image/png;base64,${btoa(`${width}x${height}`)}`
}

function harness() {
  const draws: { surface: number; args: number[] }[] = []
  const surfaces: { width: number; height: number }[] = []
  const closed: string[] = []
  const ops = createImageOps({
    decode: async (blob): Promise<Bitmap> => {
      const [width, height] = (await blob.text()).split("x").map(Number)
      return { width: width!, height: height!, close: () => closed.push(`${width}x${height}`) }
    },
    surface: (width, height): ImageSurface => {
      const index = surfaces.push({ width, height }) - 1
      return {
        getContext: () => ({
          drawImage: (_image, ...args) => {
            draws.push({ surface: index, args })
          },
        }),
        convertToBlob: async () => new Blob([`png ${width}x${height}`], { type: "image/png" }),
      }
    },
  })
  return { ops, draws, surfaces, closed }
}

describe("data URL helpers", () => {
  it("round-trips base64 payloads", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,aGVsbG8=")
    expect(blob.type).toBe("image/png")
    expect(await blob.text()).toBe("hello")
    expect(await blobToBase64(blob)).toBe("aGVsbG8=")
  })

  it("decodes percent-encoded payloads and refuses non data URLs", async () => {
    expect(await dataUrlToBlob("data:text/plain,a%20b").text()).toBe("a b")
    expect(() => dataUrlToBlob("https://example.com/a.png")).toThrow("not a data URL")
  })

  it("encodes payloads larger than one argument chunk", async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251)
    const encoded = await blobToBase64(new Blob([bytes]))
    expect(Buffer.from(encoded, "base64").equals(Buffer.from(bytes))).toBe(true)
  })
})

describe("createImageOps", () => {
  it("reads a capture's size and releases the bitmap", async () => {
    const { ops, closed } = harness()
    await expect(ops.size(shot(800, 600))).resolves.toEqual({ width: 800, height: 600 })
    expect(closed).toEqual(["800x600"])
  })

  it("crops to the captured area when the element runs off screen", async () => {
    const { ops, draws, surfaces } = harness()
    const encoded = await ops.crop(shot(800, 600), { x: 700, y: -20, width: 300, height: 100 })
    expect(surfaces).toEqual([{ width: 100, height: 100 }])
    expect(draws[0]?.args).toEqual([700, 0, 100, 100, 0, 0, 100, 100])
    expect(Buffer.from(encoded, "base64").toString()).toBe("png 100x100")
  })

  it("stacks the bottom rows of each segment", async () => {
    const { ops, draws, surfaces } = harness()
    await ops.stitch([shot(500, 1000), shot(500, 1000), shot(500, 1000)], 500, [1000, 1000, 500])
    expect(surfaces).toEqual([{ width: 500, height: 2500 }])
    expect(draws.map((draw) => draw.args)).toEqual([
      [0, 0, 500, 1000, 0, 0, 500, 1000],
      [0, 0, 500, 1000, 0, 1000, 500, 1000],
      [0, 500, 500, 500, 0, 2000, 500, 500],
    ])
  })

  it("stops at the largest canvas Chrome draws", async () => {
    const { ops, surfaces, draws } = harness()
    const segments = Array.from({ length: 10 }, () => shot(100, 2000))
    await ops.stitch(
      segments,
      100,
      segments.map(() => 2000)
    )
    expect(surfaces[0]?.height).toBe(MAX_CANVAS_SIDE)
    const drawn = draws.reduce((sum, draw) => sum + draw.args[3]!, 0)
    expect(drawn).toBe(MAX_CANVAS_SIDE)
  })
})
