import { openGifFrameSource } from "./gif-source"
import { NativeVideoPrepareError, VideoPreprocessError } from "./frame-source"

/**
 * A GIF whose LZW stream re-sends the clear code before every pixel, so the
 * dictionary never grows and every code is 3 bits. Valid per the spec, and
 * small enough to build inline. Frames are full-screen, one palette index each.
 */
function stripeGif(
  width: number,
  height: number,
  frames: Array<{ index: number; delayCs: number }>
) {
  const bytes: number[] = [..."GIF89a"].map((c) => c.charCodeAt(0))
  bytes.push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0x81, 0, 0)
  // 4-colour global table: red, green, blue, white.
  bytes.push(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255)
  for (const frame of frames) {
    bytes.push(0x21, 0xf9, 4, 0, frame.delayCs & 0xff, frame.delayCs >> 8, 0, 0)
    bytes.push(0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0)
    const codes: number[] = []
    for (let i = 0; i < width * height; i++) codes.push(4, frame.index)
    codes.push(5)
    const data: number[] = []
    let buffer = 0
    let bits = 0
    for (const code of codes) {
      buffer |= code << bits
      bits += 3
      while (bits >= 8) {
        data.push(buffer & 0xff)
        buffer >>= 8
        bits -= 8
      }
    }
    if (bits > 0) data.push(buffer & 0xff)
    bytes.push(2)
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255)
      bytes.push(chunk.length, ...chunk)
    }
    bytes.push(0)
  }
  bytes.push(0x3b)
  return new Blob([Uint8Array.from(bytes)], { type: "image/gif" })
}

describe("openGifFrameSource", () => {
  it("returns null for a still GIF so it takes the image path", async () => {
    await expect(
      openGifFrameSource(stripeGif(2, 2, [{ index: 0, delayCs: 10 }]))
    ).resolves.toBeNull()
  })

  it("describes an animated GIF from its timeline", async () => {
    const source = await openGifFrameSource(
      stripeGif(8, 4, [
        { index: 0, delayCs: 50 },
        { index: 1, delayCs: 50 },
        { index: 2, delayCs: 100 },
      ])
    )
    expect(source).not.toBeNull()
    expect(source!.engine).toBe("gif")
    expect(source!.info).toEqual({
      kind: "gif",
      mediaType: "image/gif",
      durationSec: 2,
      width: 8,
      height: 4,
      frameCount: 3,
    })
  })

  it("grabs the frame on screen at each time, fitted to the box", async () => {
    const source = (await openGifFrameSource(
      stripeGif(8, 4, [
        { index: 0, delayCs: 50 },
        { index: 1, delayCs: 50 },
        { index: 2, delayCs: 100 },
      ])
    ))!
    const progress = jest.fn()
    const frames = await source.grab(
      [0.1, 0.7, 1.5, 0.2],
      { maxWidth: 4, maxHeight: 4 },
      { onFrame: progress }
    )
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [4, 2],
      [4, 2],
      [4, 2],
      [4, 2],
    ])
    expect(frames.map((f) => Array.from(f.data.subarray(0, 3)))).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 0, 0],
    ])
    // The same frame at two times is fitted once and shared.
    expect(frames[3]).toBe(frames[0])
    expect(progress).toHaveBeenCalledTimes(4)
    expect(source.frameKeyAt!(0.7)).toBe(1)
  })

  it("refuses native delivery: no video provider takes a GIF", async () => {
    const source = (await openGifFrameSource(
      stripeGif(1, 1, [
        { index: 0, delayCs: 10 },
        { index: 1, delayCs: 10 },
      ])
    ))!
    await expect(source.readNative(null)).rejects.toMatchObject({ reason: "format" })
    await expect(source.readNative(null)).rejects.toBeInstanceOf(NativeVideoPrepareError)
    await expect(source.close()).resolves.toBeUndefined()
  })

  it("reports a corrupt GIF as undecodable", async () => {
    const broken = new Blob([new TextEncoder().encode("GIF89a")], { type: "image/gif" })
    await expect(openGifFrameSource(broken)).rejects.toBeInstanceOf(VideoPreprocessError)
    await expect(openGifFrameSource(broken)).rejects.toMatchObject({ reason: "undecodable" })
  })

  it("stops when the run is aborted", async () => {
    const source = (await openGifFrameSource(
      stripeGif(1, 1, [
        { index: 0, delayCs: 10 },
        { index: 1, delayCs: 10 },
      ])
    ))!
    const controller = new AbortController()
    controller.abort()
    await expect(
      source.grab([0], { maxWidth: 1, maxHeight: 1 }, { signal: controller.signal })
    ).rejects.toMatchObject({ reason: "aborted" })
  })
})
