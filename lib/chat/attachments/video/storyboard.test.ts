import { createPixelBuffer, type PixelBuffer } from "@/lib/images/pixel-buffer"
import {
  STORYBOARD_BACKGROUND,
  STORYBOARD_MAX_LONG_EDGE,
  STORYBOARD_MIN_CELL_EDGE,
  composeStoryboard,
  drawTimecode,
  fitBuffer,
  flattenOnto,
  measureTimecode,
  storyboardLayout,
  timecodeScaleFor,
} from "./storyboard"

function solid(width: number, height: number, rgba: [number, number, number, number]): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) buffer.data.set(rgba, i)
  return buffer
}

function pixel(buffer: PixelBuffer, x: number, y: number) {
  const i = (y * buffer.width + x) * 4
  return Array.from(buffer.data.subarray(i, i + 4))
}

describe("storyboardLayout", () => {
  it("lays nine 16:9 frames out as a 3×3 grid inside the long edge", () => {
    const layout = storyboardLayout(9, 1920, 1080)
    expect(layout).toMatchObject({ columns: 3, rows: 3 })
    expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(STORYBOARD_MAX_LONG_EDGE)
    expect(layout.cellWidth / layout.cellHeight).toBeCloseTo(16 / 9, 1)
  })

  it("uses more rows than columns for portrait video", () => {
    const layout = storyboardLayout(9, 1080, 1920)
    expect(layout.columns).toBeGreaterThanOrEqual(layout.rows)
    expect(layout.height).toBeLessThanOrEqual(STORYBOARD_MAX_LONG_EDGE)
    expect(layout.width).toBeLessThanOrEqual(STORYBOARD_MAX_LONG_EDGE)
  })

  it("keeps every frame reachable", () => {
    for (const count of [1, 2, 4, 5, 7, 12, 16]) {
      const layout = storyboardLayout(count, 1280, 720)
      expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count)
      expect(layout.width).toBe(
        layout.columns * layout.cellWidth + (layout.columns - 1) * layout.gap
      )
    }
  })

  it("never makes a cell larger than a small source frame", () => {
    const layout = storyboardLayout(4, 320, 240)
    expect(layout.cellWidth).toBe(320)
    expect(layout.cellHeight).toBe(240)
  })

  it("raises a tiny source to the minimum legible cell", () => {
    const layout = storyboardLayout(4, 16, 16)
    expect(Math.min(layout.cellWidth, layout.cellHeight)).toBe(STORYBOARD_MIN_CELL_EDGE)
  })

  it("falls back to 16:9 when the source size is unknown", () => {
    const layout = storyboardLayout(4, 0, 0)
    expect(layout.cellWidth / layout.cellHeight).toBeCloseTo(16 / 9, 1)
  })
})

describe("flattenOnto / fitBuffer", () => {
  it("composites alpha over the given colour", () => {
    const half = solid(1, 1, [0, 0, 0, 128])
    expect(pixel(flattenOnto(half, [255, 255, 255]), 0, 0)).toEqual([127, 127, 127, 255])
  })

  it("shrinks to fit and only upscales when asked", () => {
    const big = solid(400, 200, [1, 2, 3, 255])
    expect(fitBuffer(big, 100, 100)).toMatchObject({ width: 100, height: 50 })
    const small = solid(10, 10, [1, 2, 3, 255])
    expect(fitBuffer(small, 100, 50)).toBe(small)
    expect(fitBuffer(small, 100, 50, true)).toMatchObject({ width: 50, height: 50 })
  })
})

describe("timecode font", () => {
  it("measures only glyphs the font has", () => {
    expect(measureTimecode("0:05", 1)).toEqual({ width: 4 * 4 - 1, height: 5 })
    expect(measureTimecode("0:05", 3)).toEqual({ width: 45, height: 15 })
    expect(measureTimecode("abc", 2)).toEqual({ width: 0, height: 0 })
  })

  it("draws white ink on a dark plate and leaves the rest of the frame alone", () => {
    const frame = solid(40, 20, [200, 0, 0, 255])
    drawTimecode(frame, 1, 1, "1", 1)
    // Plate starts at (1,1); the glyph "1" has ink at its top-middle (col 1),
    // offset by the 2px pad.
    expect(pixel(frame, 1 + 2 + 1, 1 + 2)).toEqual([255, 255, 255, 255])
    // A plate pixel with no ink is darkened red.
    const plate = pixel(frame, 1, 1)
    expect(plate[0]).toBeLessThan(200)
    expect(plate.slice(1, 3)).toEqual([0, 0])
    // Outside the plate the frame is untouched.
    expect(pixel(frame, 39, 19)).toEqual([200, 0, 0, 255])
  })

  it("scales the glyphs with the cell height, within bounds", () => {
    expect(timecodeScaleFor(40)).toBe(1)
    expect(timecodeScaleFor(280)).toBe(4)
    expect(timecodeScaleFor(5000)).toBe(6)
  })
})

describe("composeStoryboard", () => {
  it("tiles frames in reading order on the background colour", () => {
    const layout = storyboardLayout(4, 100, 100, 404, 4)
    expect(layout).toMatchObject({ columns: 2, rows: 2, cellWidth: 100, cellHeight: 100 })
    const colours: Array<[number, number, number, number]> = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]
    const board = composeStoryboard(
      colours.map((c) => solid(100, 100, c)),
      [],
      layout
    )
    expect(board).toMatchObject({ width: 204, height: 204 })
    expect(pixel(board, 50, 10)).toEqual([255, 0, 0, 255])
    expect(pixel(board, 154, 10)).toEqual([0, 255, 0, 255])
    expect(pixel(board, 50, 150)).toEqual([0, 0, 255, 255])
    // The gap and the unfilled fourth cell show the background.
    expect(pixel(board, 101, 10)).toEqual([...STORYBOARD_BACKGROUND, 255])
    expect(pixel(board, 150, 150)).toEqual([...STORYBOARD_BACKGROUND, 255])
  })

  it("centres a frame of a different aspect ratio and flattens its transparency", () => {
    const layout = storyboardLayout(1, 100, 100, 100, 0)
    const wide = solid(100, 50, [0, 0, 0, 0])
    const board = composeStoryboard([wide], [], layout)
    // Letterbox bars keep the background; the frame's clear pixels become white.
    expect(pixel(board, 50, 5)).toEqual([...STORYBOARD_BACKGROUND, 255])
    expect(pixel(board, 50, 50)).toEqual([255, 255, 255, 255])
  })

  it("stamps each frame's label inside its own cell, bottom-left", () => {
    const layout = storyboardLayout(2, 280, 280, 564, 4)
    // Two equal-size options; the tie goes to more columns.
    expect(layout).toMatchObject({ columns: 2, rows: 1, cellHeight: 280 })
    const board = composeStoryboard(
      [solid(280, 280, [255, 0, 0, 255]), solid(280, 280, [0, 0, 255, 255])],
      ["0:01", "0:02"],
      layout
    )
    const scale = timecodeScaleFor(layout.cellHeight)
    const bottomLeftOfSecond = pixel(
      board,
      layout.cellWidth + layout.gap + 3 * scale,
      280 - 3 * scale - 1
    )
    // Dark plate over blue.
    expect(bottomLeftOfSecond[2]).toBeLessThan(255)
    expect(bottomLeftOfSecond[0]).toBe(0)
    // The top of each cell is untouched.
    expect(pixel(board, 10, 10)).toEqual([255, 0, 0, 255])
  })
})
