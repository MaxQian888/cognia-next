import {
  GIF_MAX_CANVAS_PIXELS,
  GIF_MIN_FRAME_DELAY_MS,
  GifDecodeError,
  composeGifFrames,
  decodeGifFrameIndices,
  gifFrameIndexAt,
  isAnimatedGif,
  parseGifTimeline,
} from "./gif"

// ── A minimal, spec-following GIF encoder for fixtures ──────────────────────
// Real LZW (growing dictionary, width bumps, KwKwK) so the decoder is tested
// against the compression it meets in the wild, not a clear-code-only stream.

function lzwEncode(indices: readonly number[], minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  const out: number[] = []
  let codeSize = minCodeSize + 1
  let next = clearCode + 2
  let dict = new Map<string, number>()
  let buffer = 0
  let bits = 0
  const write = (code: number) => {
    buffer |= code << bits
    bits += codeSize
    while (bits >= 8) {
      out.push(buffer & 0xff)
      buffer >>>= 8
      bits -= 8
    }
  }
  const grow = () => {
    next += 1
    if (next > 1 << codeSize && codeSize < 12) codeSize += 1
  }

  write(clearCode)
  let current = indices[0]!
  for (const k of indices.slice(1)) {
    const key = `${current},${k}`
    const hit = dict.get(key)
    if (hit !== undefined) {
      current = hit
      continue
    }
    write(current)
    if (next < 4095) {
      dict.set(key, next)
      grow()
    } else {
      write(clearCode)
      dict = new Map()
      codeSize = minCodeSize + 1
      next = clearCode + 2
    }
    current = k
  }
  write(current)
  grow()
  write(endCode)
  if (bits > 0) out.push(buffer & 0xff)
  return out
}

function subBlocks(data: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255)
    out.push(chunk.length, ...chunk)
  }
  out.push(0)
  return out
}

interface FixtureFrame {
  left?: number
  top?: number
  width: number
  height: number
  /** Row-major pixel indices, in display order. */
  pixels: number[]
  delayCs?: number
  disposal?: number
  transparentIndex?: number
  interlaced?: boolean
  localPalette?: Array<[number, number, number]>
}

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff]

function buildGif(
  width: number,
  height: number,
  palette: Array<[number, number, number]> | null,
  frames: FixtureFrame[],
  { trailer = true }: { trailer?: boolean } = {}
): Uint8Array {
  const bytes: number[] = [..."GIF89a"].map((c) => c.charCodeAt(0))
  const tableBits = (size: number) => Math.max(1, Math.ceil(Math.log2(size))) - 1
  const padTable = (p: Array<[number, number, number]>) => {
    const size = 1 << (tableBits(p.length) + 1)
    const flat = p.flat()
    while (flat.length < size * 3) flat.push(0)
    return { size, flat }
  }
  const global = palette ? padTable(palette) : null
  bytes.push(...u16le(width), ...u16le(height))
  bytes.push(global ? 0x80 | tableBits(palette!.length) : 0, 0, 0)
  if (global) bytes.push(...global.flat)

  for (const frame of frames) {
    const disposal = frame.disposal ?? 0
    const transparent = frame.transparentIndex
    bytes.push(0x21, 0xf9, 4)
    bytes.push((disposal << 2) | (transparent !== undefined ? 1 : 0))
    bytes.push(...u16le(frame.delayCs ?? 10), transparent ?? 0, 0)

    const local = frame.localPalette ? padTable(frame.localPalette) : null
    bytes.push(0x2c, ...u16le(frame.left ?? 0), ...u16le(frame.top ?? 0))
    bytes.push(...u16le(frame.width), ...u16le(frame.height))
    bytes.push(
      (local ? 0x80 | tableBits(frame.localPalette!.length) : 0) | (frame.interlaced ? 0x40 : 0)
    )
    if (local) bytes.push(...local.flat)

    let stream = frame.pixels
    if (frame.interlaced) {
      const rows: number[] = []
      for (const [start, step] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
      ]) {
        for (let r = start!; r < frame.height; r += step!) rows.push(r)
      }
      stream = rows.flatMap((r) => frame.pixels.slice(r * frame.width, (r + 1) * frame.width))
    }
    const minCodeSize = 2
    bytes.push(minCodeSize, ...subBlocks(lzwEncode(stream, minCodeSize)))
  }
  if (trailer) bytes.push(0x3b)
  return Uint8Array.from(bytes)
}

const RED: [number, number, number] = [255, 0, 0]
const GREEN: [number, number, number] = [0, 255, 0]
const BLUE: [number, number, number] = [0, 0, 255]
const WHITE: [number, number, number] = [255, 255, 255]
const PALETTE = [RED, GREEN, BLUE, WHITE]

function pixelAt(buffer: { data: Uint8ClampedArray; width: number }, x: number, y: number) {
  const i = (y * buffer.width + x) * 4
  return Array.from(buffer.data.subarray(i, i + 4))
}

describe("parseGifTimeline", () => {
  it("reads the screen, frames, delays and offsets without decoding pixels", () => {
    const gif = buildGif(2, 2, PALETTE, [
      { width: 2, height: 2, pixels: [0, 1, 2, 3], delayCs: 20 },
      { width: 2, height: 2, pixels: [3, 2, 1, 0], delayCs: 50, disposal: 2 },
    ])
    const timeline = parseGifTimeline(gif)
    expect(timeline.width).toBe(2)
    expect(timeline.height).toBe(2)
    expect(timeline.frames).toHaveLength(2)
    expect(timeline.frames[0]).toMatchObject({ startMs: 0, delayMs: 200, disposal: 0 })
    expect(timeline.frames[1]).toMatchObject({ startMs: 200, delayMs: 500, disposal: 2 })
    expect(timeline.durationMs).toBe(700)
  })

  it("treats a 0 or 1 centisecond delay the way browsers do", () => {
    const gif = buildGif(1, 1, PALETTE, [
      { width: 1, height: 1, pixels: [0], delayCs: 0 },
      { width: 1, height: 1, pixels: [1], delayCs: 1 },
    ])
    const timeline = parseGifTimeline(gif)
    expect(timeline.frames.map((f) => f.delayMs)).toEqual([
      GIF_MIN_FRAME_DELAY_MS,
      GIF_MIN_FRAME_DELAY_MS,
    ])
  })

  it("rejects bytes that are not a GIF", () => {
    expect(() => parseGifTimeline(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(
      GifDecodeError
    )
    expect(() => parseGifTimeline(new TextEncoder().encode("PNGPNGPNGPNGPNG"))).toThrow(/signature/)
  })

  it("refuses a logical screen above the decode ceiling before allocating", () => {
    const gif = buildGif(1, 1, PALETTE, [{ width: 1, height: 1, pixels: [0] }])
    // Patch the header to 65535 × 65535.
    gif.set([0xff, 0xff, 0xff, 0xff], 6)
    expect(65535 * 65535).toBeGreaterThan(GIF_MAX_CANVAS_PIXELS)
    expect(() => parseGifTimeline(gif)).toThrow(/ceiling/)
  })

  it("rejects a GIF with no frames", () => {
    const gif = buildGif(1, 1, PALETTE, [])
    expect(() => parseGifTimeline(gif)).toThrow(/no frames/)
  })

  it("keeps the frames read before a missing trailer", () => {
    const gif = buildGif(
      1,
      1,
      PALETTE,
      [
        { width: 1, height: 1, pixels: [0] },
        { width: 1, height: 1, pixels: [1] },
      ],
      { trailer: false }
    )
    expect(parseGifTimeline(gif).frames).toHaveLength(2)
  })

  it("throws when a frame has neither a local nor a global colour table", () => {
    const gif = buildGif(1, 1, null, [{ width: 1, height: 1, pixels: [0] }])
    expect(() => parseGifTimeline(gif)).toThrow(/colour table/)
  })
})

describe("isAnimatedGif", () => {
  it("is true only for more than one frame", () => {
    const still = buildGif(1, 1, PALETTE, [{ width: 1, height: 1, pixels: [0] }])
    const animated = buildGif(1, 1, PALETTE, [
      { width: 1, height: 1, pixels: [0] },
      { width: 1, height: 1, pixels: [1] },
    ])
    expect(isAnimatedGif(still)).toBe(false)
    expect(isAnimatedGif(animated)).toBe(true)
    expect(isAnimatedGif(Uint8Array.from([1, 2, 3]))).toBe(false)
  })
})

describe("gifFrameIndexAt", () => {
  it("finds the frame on screen at a time, clamped to the ends", () => {
    const timeline = parseGifTimeline(
      buildGif(1, 1, PALETTE, [
        { width: 1, height: 1, pixels: [0], delayCs: 10 },
        { width: 1, height: 1, pixels: [1], delayCs: 30 },
        { width: 1, height: 1, pixels: [2], delayCs: 10 },
      ])
    )
    expect(gifFrameIndexAt(timeline, -5)).toBe(0)
    expect(gifFrameIndexAt(timeline, 99)).toBe(0)
    expect(gifFrameIndexAt(timeline, 100)).toBe(1)
    expect(gifFrameIndexAt(timeline, 399)).toBe(1)
    expect(gifFrameIndexAt(timeline, 400)).toBe(2)
    expect(gifFrameIndexAt(timeline, 10_000)).toBe(2)
  })
})

describe("decodeGifFrameIndices", () => {
  it("round-trips a long stream that grows the dictionary past several code widths", () => {
    const width = 64
    const height = 64
    // Repetitive runs force long dictionary strings and the KwKwK case; the
    // noise term keeps the table growing towards the 12-bit limit.
    const pixels = Array.from({ length: width * height }, (_, i) =>
      i % 7 === 0 ? (i * 31) % 4 : Math.floor(i / 5) % 4
    )
    const gif = buildGif(width, height, PALETTE, [{ width, height, pixels }])
    const frame = parseGifTimeline(gif).frames[0]!
    const { indices, decoded } = decodeGifFrameIndices(gif, frame)
    expect(decoded).toBe(width * height)
    expect(Array.from(indices)).toEqual(pixels)
  })

  it("decodes a run of one repeated index (the KwKwK code path)", () => {
    const pixels = new Array(300).fill(2)
    const gif = buildGif(30, 10, PALETTE, [{ width: 30, height: 10, pixels }])
    const frame = parseGifTimeline(gif).frames[0]!
    const { indices, decoded } = decodeGifFrameIndices(gif, frame)
    expect(decoded).toBe(300)
    expect(indices.every((v) => v === 2)).toBe(true)
  })

  it("stops at a truncated stream and reports how far it got", () => {
    const pixels = Array.from({ length: 400 }, (_, i) => (i * 13) % 4)
    const gif = buildGif(20, 20, PALETTE, [{ width: 20, height: 20, pixels }])
    const frame = parseGifTimeline(gif).frames[0]!
    const cut = gif.slice(0, frame.dataOffset + 12)
    const { decoded } = decodeGifFrameIndices(cut, frame)
    expect(decoded).toBeGreaterThan(0)
    expect(decoded).toBeLessThan(400)
  })
})

/**
 * A 40×30, 6-frame GIF written by ffmpeg (`testsrc2` → `palettegen` →
 * `paletteuse`). Its muxer diffs frames, so later frames are small rectangles
 * with transparent pixels — compositing has to be right, not just LZW.
 * `FFMPEG_RGBA_FNV1A` is the FNV-1a hash of `ffmpeg -i small.gif -f rawvideo
 * -pix_fmt rgba`, i.e. of ffmpeg's own composite of every frame.
 */
const FFMPEG_GIF_BASE64 = [
  "R0lGODlhKAAeAPf/MQAAPgAA/QA9AAA+PQD+AAH+/hoACxwAPSIxACczEDwAADwAPDw+AFUABV81AGQWAHkjAH4A/ZSkVqGb",
  "Z7iIhceSMMx8jNh/X+CGL+SGGe1+LfwAAP0A/P1/AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+",
  "AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AP3+AAD/ACH/C05FVFNDQVBF",
  "Mi4wAwEAAAAh+QQECgAfACwAAAAAKAAeAAAI/wAjCBwokIDBgx4SKgzAsCFDDhAjFphIkSDBgwgVJnToMKJEihMFHhhJUoDJ",
  "kwxSqgTAsiXLBTBjDphJUyTJkSdRqkzp0mVMmTRn2ryZ02TKBCt7vvy5IKjQCDdxFt3JUykApk2d2lSgAIMGDBkQJBALFqwD",
  "B1YBNGigoa0GsWQzbKWgocGDDBIQIJCQAQKEDBXQWm1gQcODBxomJEgwAcODDRu4aujA1WSHDpOPMrjMUsGFCwpYTv55efJM",
  "yFwvVxZw+fJOzgA8g2Z5mXTr05EVXG6AIfDkyw4qVIAwOe3uz4hbM0atuwPvCglad4AgHAJspccvNJDuYALzyatLd9LQDNuA",
  "eQOiO9g2PYC5agWWW7/uwNIABQroAdSOKR03V8+G3SXBWBJg4BdggtmHH0uEBZjYWI1BwNxabWUQll4IWGjhWfWdxyBbbi22",
  "GAYYMPcffFMxgFRVSmHlVHu5nViUAFQxkJaLTpn434w13sjUizqullOPVuEYVJAoDqliUi3+mGOMO6a4k48/AQmlkDpNWaST",
  "R16ZZJZM9mQkTUjyuCSLYnJJppdmatlklU+eiKVRVFEJVJdyfkmnm2nCiaecZq5o45Z+rplnm2H6pOZMAQEAIfkEBQoA/wAs",
  "JwAdAAEAAQAACAQA/wUEACH5BAUKAP8ALAAAAAAKAAoAAAgvADcIHCjw3z+CBA0WNMjwwIGFDP85hNjw4YaIBidexPhPA0WG",
  "GjIeEOlQJMkDAQEAIfkEBQoA/wAsJwAdAAEAAQAACAQA/wUEACH5BAUKAP8ALCcAHQABAAEAAAgEAP8FBAAh+QQFCgD/ACwC",
  "AAIACgAKAAAIMQAVCBwoQMC/fwMJGkSo4KDDfwcOCHx4MOJEigkp/qMwUOPBix4dKrhwoYFHkg3/BQQAOw==",
].join("")
const FFMPEG_RGBA_FNV1A = 0x2a48735e

describe("a GIF from a real encoder", () => {
  it("composites every frame byte-identically to ffmpeg's own decoder", () => {
    const gif = Uint8Array.from(Buffer.from(FFMPEG_GIF_BASE64, "base64"))
    const timeline = parseGifTimeline(gif)
    expect(timeline.frames).toHaveLength(6)
    let hash = 0x811c9dc5
    composeGifFrames(gif, timeline, {
      onFrame: (_index, canvas) => {
        for (const byte of canvas.data) {
          hash ^= byte
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
      },
    })
    expect(hash).toBe(FFMPEG_RGBA_FNV1A)
  })
})

describe("composeGifFrames", () => {
  it("captures only the requested frames as full RGBA canvases", () => {
    const gif = buildGif(2, 1, PALETTE, [
      { width: 2, height: 1, pixels: [0, 0] },
      { width: 2, height: 1, pixels: [1, 1] },
      { width: 2, height: 1, pixels: [2, 2] },
    ])
    const timeline = parseGifTimeline(gif)
    const out = composeGifFrames(gif, timeline, { capture: new Set([0, 2]) })
    expect([...out.keys()]).toEqual([0, 2])
    expect(pixelAt(out.get(0)!, 1, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(out.get(2)!, 0, 0)).toEqual([0, 0, 255, 255])
  })

  it("lets a transparent pixel reveal what earlier frames left", () => {
    const gif = buildGif(2, 1, PALETTE, [
      { width: 2, height: 1, pixels: [0, 0] },
      { width: 2, height: 1, pixels: [3, 1], transparentIndex: 3 },
    ])
    const timeline = parseGifTimeline(gif)
    const out = composeGifFrames(gif, timeline, { capture: new Set([1]) })
    expect(pixelAt(out.get(1)!, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(out.get(1)!, 1, 0)).toEqual([0, 255, 0, 255])
  })

  it("clears the frame rectangle for disposal 2 and restores it for disposal 3", () => {
    const gif = buildGif(3, 1, PALETTE, [
      { width: 3, height: 1, pixels: [0, 0, 0] },
      { left: 1, width: 1, height: 1, pixels: [1], disposal: 2 },
      { width: 1, height: 1, pixels: [2], disposal: 3 },
      { left: 2, width: 1, height: 1, pixels: [3] },
    ])
    const timeline = parseGifTimeline(gif)
    const out = composeGifFrames(gif, timeline, { capture: new Set([1, 2, 3]) })
    // Frame 1 is shown over red.
    expect(pixelAt(out.get(1)!, 1, 0)).toEqual([0, 255, 0, 255])
    // Its disposal cleared x=1 before frame 2 drew at x=0.
    expect(pixelAt(out.get(2)!, 1, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(out.get(2)!, 0, 0)).toEqual([0, 0, 255, 255])
    // Frame 2's disposal restored x=0 to red before frame 3.
    expect(pixelAt(out.get(3)!, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(out.get(3)!, 2, 0)).toEqual([255, 255, 255, 255])
  })

  it("places interlaced rows at their display positions", () => {
    const width = 1
    const height = 9
    const pixels = [0, 1, 2, 3, 0, 1, 2, 3, 0]
    const gif = buildGif(width, height, PALETTE, [{ width, height, pixels, interlaced: true }])
    const timeline = parseGifTimeline(gif)
    const frame = composeGifFrames(gif, timeline, { capture: new Set([0]) }).get(0)!
    const colours = pixels.map((_, y) => pixelAt(frame, 0, y).slice(0, 3))
    expect(colours).toEqual(pixels.map((p) => PALETTE[p]))
  })

  it("draws with a frame's local palette over the global one", () => {
    const gif = buildGif(1, 1, PALETTE, [
      { width: 1, height: 1, pixels: [0], localPalette: [WHITE, RED] },
    ])
    const out = composeGifFrames(gif, parseGifTimeline(gif), { capture: new Set([0]) })
    expect(pixelAt(out.get(0)!, 0, 0)).toEqual([255, 255, 255, 255])
  })

  it("clips a frame that extends past the logical screen", () => {
    const gif = buildGif(2, 2, PALETTE, [
      { left: 1, top: 1, width: 2, height: 2, pixels: [1, 1, 1, 1] },
    ])
    const out = composeGifFrames(gif, parseGifTimeline(gif), { capture: new Set([0]) })
    const frame = out.get(0)!
    expect(frame.data).toHaveLength(16)
    expect(pixelAt(frame, 1, 1)).toEqual([0, 255, 0, 255])
    expect(pixelAt(frame, 0, 0)).toEqual([0, 0, 0, 0])
  })

  it("streams every composited frame to onFrame", () => {
    const gif = buildGif(1, 1, PALETTE, [
      { width: 1, height: 1, pixels: [0] },
      { width: 1, height: 1, pixels: [2] },
    ])
    const seen: number[][] = []
    composeGifFrames(gif, parseGifTimeline(gif), {
      onFrame: (_index, canvas) => seen.push(Array.from(canvas.data)),
    })
    expect(seen).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ])
  })
})
