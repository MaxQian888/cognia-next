/**
 * GIF decoding without a DOM.
 *
 * Every other decode in this engine goes through `ImageDecoder` / canvas
 * (`codec.ts`), and for a GIF both hand back ONE frame. That was the whole of
 * the app's GIF support: an animated GIF reached the model as its first frame,
 * and past 1568 px the canvas re-encode turned it into a still PNG on the way
 * out. Reading the frames needs the file format itself, so this module parses
 * it directly — which also keeps it deterministic across the three shells
 * (WKWebView has no reliable `ImageDecoder`) and testable in the `node` project.
 *
 * Two passes, deliberately separate:
 *
 *  - {@link parseGifTimeline} walks the block structure and records where every
 *    frame's compressed data sits and when it shows, without decompressing a
 *    single pixel. Enough to answer "is this animated?" and "which frame is on
 *    screen at 1.3 s?" cheaply.
 *  - {@link composeGifFrames} replays the frames in order onto one canvas,
 *    honouring disposal and transparency, and copies out only the frames the
 *    caller asked for. A GIF has to be composited from the start to know what
 *    frame N looks like; holding every frame would be `frames × width × height
 *    × 4` bytes, so it holds one canvas and the requested snapshots.
 */

import type { PixelBuffer } from "./pixel-buffer"

export class GifDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GifDecodeError"
  }
}

/**
 * Largest logical screen the compositor will allocate: 4096 × 4096 RGBA is
 * 64 MiB, already more than a composer attachment should ever cost. The
 * header's two u16 fields allow 65535 × 65535 (16 GiB), so without a ceiling a
 * crafted 30-byte file could ask for that.
 */
export const GIF_MAX_CANVAS_PIXELS = 4096 * 4096

/**
 * Browsers render a frame delay of 0 or 1 centisecond as 100 ms, and most GIFs
 * in the wild are authored against that behaviour. Using the literal value
 * would make those GIFs play (and sample) ten times faster than anyone sees them.
 */
export const GIF_MIN_FRAME_DELAY_MS = 100

/** Disposal methods from the Graphic Control Extension. */
export type GifDisposal = 0 | 1 | 2 | 3

export interface GifFrameInfo {
  index: number
  left: number
  top: number
  width: number
  height: number
  /** When this frame appears, measured from the first frame. */
  startMs: number
  delayMs: number
  /** 0/1 keep the frame, 2 clears its rectangle, 3 restores what was under it. */
  disposal: GifDisposal
  transparentIndex: number | null
  interlaced: boolean
  /** Byte offset of the colour table this frame draws with (local or global). */
  colorTableOffset: number
  colorTableSize: number
  lzwMinCodeSize: number
  /** Byte offset of the first data sub-block's length byte. */
  dataOffset: number
}

export interface GifTimeline {
  width: number
  height: number
  frames: GifFrameInfo[]
  durationMs: number
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

/** Advance past a run of data sub-blocks. Returns the offset after the terminator. */
function skipSubBlocks(bytes: Uint8Array, offset: number): number {
  let pos = offset
  while (pos < bytes.length) {
    const size = bytes[pos]!
    pos += 1
    if (size === 0) return pos
    pos += size
  }
  // Truncated: the caller decides whether what came before is usable.
  return bytes.length
}

/**
 * Parse the block structure. Throws {@link GifDecodeError} when the bytes are
 * not a GIF, declare an oversized canvas, or contain no frame at all.
 *
 * A file that ends early (no trailer, or a cut data run) keeps every frame that
 * started before the cut — the same thing a browser shows for it.
 */
export function parseGifTimeline(bytes: Uint8Array): GifTimeline {
  if (bytes.length < 13) throw new GifDecodeError("file is too short to be a GIF")
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new GifDecodeError("missing GIF signature")
  }
  const width = u16(bytes, 6)
  const height = u16(bytes, 8)
  if (width === 0 || height === 0) throw new GifDecodeError("logical screen has no area")
  if (width * height > GIF_MAX_CANVAS_PIXELS) {
    throw new GifDecodeError(`logical screen ${width}x${height} exceeds the decode ceiling`)
  }
  const screenPacked = bytes[10]!
  let pos = 13
  let globalTableOffset = -1
  let globalTableSize = 0
  if (screenPacked & 0x80) {
    globalTableSize = 1 << ((screenPacked & 0x07) + 1)
    globalTableOffset = pos
    pos += globalTableSize * 3
  }

  const frames: GifFrameInfo[] = []
  let elapsed = 0
  let pendingDelayMs = GIF_MIN_FRAME_DELAY_MS
  let pendingDisposal: GifDisposal = 0
  let pendingTransparent: number | null = null

  while (pos < bytes.length) {
    const introducer = bytes[pos]!
    if (introducer === 0x3b) break
    if (introducer === 0x21) {
      const label = bytes[pos + 1]
      if (label === 0xf9 && pos + 7 < bytes.length && bytes[pos + 2] === 4) {
        const packed = bytes[pos + 3]!
        const disposal = (packed >> 2) & 0x07
        pendingDisposal = (disposal <= 3 ? disposal : 0) as GifDisposal
        const delayCs = u16(bytes, pos + 4)
        pendingDelayMs = delayCs <= 1 ? GIF_MIN_FRAME_DELAY_MS : delayCs * 10
        pendingTransparent = packed & 0x01 ? bytes[pos + 6]! : null
      }
      pos = skipSubBlocks(bytes, pos + 2)
      continue
    }
    if (introducer === 0x2c) {
      if (pos + 10 > bytes.length) break
      const left = u16(bytes, pos + 1)
      const top = u16(bytes, pos + 3)
      const frameWidth = u16(bytes, pos + 5)
      const frameHeight = u16(bytes, pos + 7)
      const packed = bytes[pos + 9]!
      pos += 10
      let tableOffset = globalTableOffset
      let tableSize = globalTableSize
      if (packed & 0x80) {
        tableSize = 1 << ((packed & 0x07) + 1)
        tableOffset = pos
        pos += tableSize * 3
      }
      if (pos >= bytes.length) break
      const lzwMinCodeSize = bytes[pos]!
      pos += 1
      const dataOffset = pos
      pos = skipSubBlocks(bytes, pos)
      if (tableOffset < 0) throw new GifDecodeError("frame has no colour table")
      if (lzwMinCodeSize < 1 || lzwMinCodeSize > 11) {
        throw new GifDecodeError(`invalid LZW minimum code size ${lzwMinCodeSize}`)
      }
      if (frameWidth > 0 && frameHeight > 0) {
        frames.push({
          index: frames.length,
          left,
          top,
          width: frameWidth,
          height: frameHeight,
          startMs: elapsed,
          delayMs: pendingDelayMs,
          disposal: pendingDisposal,
          transparentIndex: pendingTransparent,
          interlaced: (packed & 0x40) !== 0,
          colorTableOffset: tableOffset,
          colorTableSize: tableSize,
          lzwMinCodeSize,
          dataOffset,
        })
        elapsed += pendingDelayMs
      }
      // A Graphic Control Extension applies to the next image only.
      pendingDelayMs = GIF_MIN_FRAME_DELAY_MS
      pendingDisposal = 0
      pendingTransparent = null
      continue
    }
    // Anything else is not a block this format defines. Stop where a browser
    // would, keeping the frames already read.
    break
  }

  if (frames.length === 0) throw new GifDecodeError("GIF contains no frames")
  return { width, height, frames, durationMs: elapsed }
}

/** True for a GIF with more than one frame. False for a still GIF or non-GIF bytes. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  try {
    return parseGifTimeline(bytes).frames.length > 1
  } catch {
    return false
  }
}

/** The frame on screen at `timeMs` (clamped into the animation's span). */
export function gifFrameIndexAt(timeline: GifTimeline, timeMs: number): number {
  const frames = timeline.frames
  if (timeMs <= 0) return 0
  let low = 0
  let high = frames.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (frames[mid]!.startMs <= timeMs) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Decompress one frame's LZW stream into colour indices.
 *
 * Returns how many pixels were actually produced: a truncated or corrupt stream
 * stops early, and the compositor leaves the remainder untouched (transparent)
 * rather than painting it with colour 0.
 */
export function decodeGifFrameIndices(
  bytes: Uint8Array,
  frame: Pick<GifFrameInfo, "dataOffset" | "lzwMinCodeSize" | "width" | "height">
): { indices: Uint8Array; decoded: number } {
  const pixelCount = frame.width * frame.height
  const indices = new Uint8Array(pixelCount)
  const minCodeSize = frame.lzwMinCodeSize
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1

  const prefix = new Int16Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)
  for (let code = 0; code < clearCode; code++) suffix[code] = code

  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1
  let available = clearCode + 2
  let oldCode = -1
  let first = 0
  let datum = 0
  let bits = 0
  let pos = frame.dataOffset
  let blockRemaining = 0
  let out = 0

  while (out < pixelCount) {
    if (bits < codeSize) {
      if (blockRemaining === 0) {
        if (pos >= bytes.length) break
        blockRemaining = bytes[pos]!
        pos += 1
        if (blockRemaining === 0) break
      }
      if (pos >= bytes.length) break
      datum |= bytes[pos]! << bits
      pos += 1
      bits += 8
      blockRemaining -= 1
      continue
    }

    let code = datum & codeMask
    datum >>>= codeSize
    bits -= codeSize

    if (code === clearCode) {
      codeSize = minCodeSize + 1
      codeMask = (1 << codeSize) - 1
      available = clearCode + 2
      oldCode = -1
      continue
    }
    if (code === endCode) break

    if (oldCode === -1) {
      if (code >= clearCode) break
      indices[out++] = code
      oldCode = code
      first = code
      continue
    }

    const inCode = code
    let top = 0
    if (code >= available) {
      // Only the one-ahead code (KwKwK) may be referenced before it exists.
      if (code > available) break
      stack[top++] = first
      code = oldCode
    }
    while (code >= clearCode) {
      if (top >= 4096) break
      stack[top++] = suffix[code]!
      code = prefix[code]!
    }
    first = suffix[code]!
    stack[top++] = first

    if (available < 4096) {
      prefix[available] = oldCode
      suffix[available] = first
      available += 1
      if ((available & codeMask) === 0 && available < 4096) {
        codeSize += 1
        codeMask = (1 << codeSize) - 1
      }
    }
    oldCode = inCode

    while (top > 0 && out < pixelCount) indices[out++] = stack[--top]!
  }

  return { indices, decoded: out }
}

/** Row order of an interlaced frame: the four passes, as destination rows. */
function interlacedRowOrder(height: number): number[] {
  const rows: number[] = []
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let row = start; row < height; row += step) rows.push(row)
  }
  return rows
}

export interface GifComposeOptions {
  /** Frame indexes whose composited canvas should be copied out. */
  capture?: ReadonlySet<number>
  /**
   * Called with the composited canvas after every frame is drawn. The buffer is
   * the live canvas: read it during the call, never keep it.
   */
  onFrame?: (index: number, canvas: PixelBuffer) => void
}

/**
 * Replay the animation and return copies of the requested frames, keyed by
 * frame index. Frames are composited exactly as a browser shows them: a
 * transparent pixel reveals what the previous frames left, and disposal runs
 * after each frame is shown.
 */
export function composeGifFrames(
  bytes: Uint8Array,
  timeline: GifTimeline,
  options: GifComposeOptions = {}
): Map<number, PixelBuffer> {
  const { width, height } = timeline
  const canvas = new Uint8ClampedArray(width * height * 4)
  const view: PixelBuffer = { data: canvas, width, height }
  const captured = new Map<number, PixelBuffer>()
  const capture = options.capture
  const lastWanted = capture && !options.onFrame ? Math.max(-1, ...capture) : Infinity

  for (const frame of timeline.frames) {
    if (frame.index > lastWanted) break

    const x0 = Math.min(frame.left, width)
    const y0 = Math.min(frame.top, height)
    const x1 = Math.min(frame.left + frame.width, width)
    const y1 = Math.min(frame.top + frame.height, height)

    let saved: Uint8ClampedArray | null = null
    if (frame.disposal === 3 && x1 > x0 && y1 > y0) {
      saved = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4)
      for (let y = y0; y < y1; y++) {
        const src = (y * width + x0) * 4
        saved.set(canvas.subarray(src, src + (x1 - x0) * 4), (y - y0) * (x1 - x0) * 4)
      }
    }

    const { indices, decoded } = decodeGifFrameIndices(bytes, frame)
    const rows = frame.interlaced ? interlacedRowOrder(frame.height) : null
    const table = frame.colorTableOffset
    for (let i = 0; i < decoded; i++) {
      const sourceRow = Math.floor(i / frame.width)
      const row = rows ? rows[sourceRow]! : sourceRow
      const col = i - sourceRow * frame.width
      const x = frame.left + col
      const y = frame.top + row
      if (x >= width || y >= height) continue
      const colorIndex = indices[i]!
      if (colorIndex === frame.transparentIndex || colorIndex >= frame.colorTableSize) continue
      const dst = (y * width + x) * 4
      const entry = table + colorIndex * 3
      canvas[dst] = bytes[entry] ?? 0
      canvas[dst + 1] = bytes[entry + 1] ?? 0
      canvas[dst + 2] = bytes[entry + 2] ?? 0
      canvas[dst + 3] = 255
    }

    options.onFrame?.(frame.index, view)
    if (capture?.has(frame.index)) {
      captured.set(frame.index, { data: new Uint8ClampedArray(canvas), width, height })
    }

    if (frame.disposal === 2) {
      for (let y = y0; y < y1; y++) {
        const start = (y * width + x0) * 4
        canvas.fill(0, start, start + (x1 - x0) * 4)
      }
    } else if (saved) {
      for (let y = y0; y < y1; y++) {
        const dst = (y * width + x0) * 4
        const src = (y - y0) * (x1 - x0) * 4
        canvas.set(saved.subarray(src, src + (x1 - x0) * 4), dst)
      }
    }
  }

  return captured
}
