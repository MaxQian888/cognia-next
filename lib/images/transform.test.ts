import { createPixelBuffer, type PixelBuffer } from "./pixel-buffer"
import {
  cropBuffer,
  flipBuffer,
  resizeBuffer,
  rotateBuffer,
  rotateQuarterTurns,
  transformBuffer,
} from "./transform"

/** Encode each pixel's red channel from a grid, so moves are readable. */
function gridBuffer(rows: number[][]): PixelBuffer {
  const height = rows.length
  const width = rows[0].length
  const buffer = createPixelBuffer(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      buffer.data[at] = rows[y][x]
      buffer.data[at + 1] = rows[y][x]
      buffer.data[at + 2] = rows[y][x]
      buffer.data[at + 3] = 255
    }
  }
  return buffer
}

function redGrid(buffer: PixelBuffer): number[][] {
  const rows: number[][] = []
  for (let y = 0; y < buffer.height; y += 1) {
    const row: number[] = []
    for (let x = 0; x < buffer.width; x += 1) row.push(buffer.data[(y * buffer.width + x) * 4])
    rows.push(row)
  }
  return rows
}

describe("cropBuffer", () => {
  it("cuts the requested window out", () => {
    const source = gridBuffer([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
    expect(redGrid(cropBuffer(source, { x: 1, y: 1, width: 2, height: 2 }))).toEqual([
      [5, 6],
      [8, 9],
    ])
  })

  it("keeps the requested size when the rect hangs off an edge", () => {
    const source = gridBuffer([
      [1, 2],
      [3, 4],
    ])
    const result = cropBuffer(source, { x: -1, y: 0, width: 2, height: 2 })
    expect(result.width).toBe(2)
    // The out-of-frame column stays transparent rather than wrapping around.
    expect(result.data[3]).toBe(0)
    expect(redGrid(result)[0][1]).toBe(1)
  })

  it("rounds fractional rects and never returns a zero-sized frame", () => {
    const source = gridBuffer([
      [1, 2],
      [3, 4],
    ])
    expect(cropBuffer(source, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 })).toMatchObject({
      width: 1,
      height: 1,
    })
  })
})

describe("resizeBuffer", () => {
  it("detaches even when the size is unchanged", () => {
    const source = gridBuffer([[10, 20]])
    const result = resizeBuffer(source, 2, 1)
    expect(result).not.toBe(source)
    expect(redGrid(result)).toEqual([[10, 20]])
  })

  it("area-averages when shrinking rather than point-sampling", () => {
    const source = gridBuffer([[0, 0, 200, 200]])
    // Point sampling would return one of the two source values. The box filter
    // over each half returns their averages.
    expect(redGrid(resizeBuffer(source, 2, 1))).toEqual([[0, 200]])
    expect(redGrid(resizeBuffer(source, 1, 1))[0][0]).toBeCloseTo(100, -1)
  })

  it("interpolates linearly when growing", () => {
    const source = gridBuffer([[0, 100]])
    const grown = redGrid(resizeBuffer(source, 4, 1))[0]
    expect(grown[0]).toBeLessThanOrEqual(grown[1])
    expect(grown[1]).toBeLessThanOrEqual(grown[2])
    expect(grown[2]).toBeLessThanOrEqual(grown[3])
    expect(grown[3]).toBeGreaterThan(grown[0])
  })

  it("keeps a flat field flat instead of fading at the border", () => {
    const flat = gridBuffer([
      [120, 120, 120],
      [120, 120, 120],
      [120, 120, 120],
    ])
    const resized = resizeBuffer(flat, 6, 6)
    for (const row of redGrid(resized)) {
      for (const value of row) expect(value).toBeCloseTo(120, -1)
    }
  })
})

describe("rotateQuarterTurns", () => {
  const source = gridBuffer([
    [1, 2],
    [3, 4],
    [5, 6],
  ])

  it("swaps the dimensions for an odd number of turns", () => {
    expect(rotateQuarterTurns(source, 1)).toMatchObject({ width: 3, height: 2 })
    expect(rotateQuarterTurns(source, 2)).toMatchObject({ width: 2, height: 3 })
  })

  it("rotates clockwise", () => {
    expect(redGrid(rotateQuarterTurns(source, 1))).toEqual([
      [5, 3, 1],
      [6, 4, 2],
    ])
  })

  it("returns the original pixels after four turns", () => {
    let result = source
    for (let i = 0; i < 4; i += 1) result = rotateQuarterTurns(result, 1)
    expect(redGrid(result)).toEqual(redGrid(source))
  })

  it("normalizes negative and oversized turn counts", () => {
    expect(redGrid(rotateQuarterTurns(source, -1))).toEqual(redGrid(rotateQuarterTurns(source, 3)))
    expect(redGrid(rotateQuarterTurns(source, 5))).toEqual(redGrid(rotateQuarterTurns(source, 1)))
    expect(redGrid(rotateQuarterTurns(source, 0))).toEqual(redGrid(source))
  })
})

describe("flipBuffer", () => {
  const source = gridBuffer([
    [1, 2],
    [3, 4],
  ])

  it("mirrors horizontally", () => {
    expect(redGrid(flipBuffer(source, { horizontal: true }))).toEqual([
      [2, 1],
      [4, 3],
    ])
  })

  it("mirrors vertically", () => {
    expect(redGrid(flipBuffer(source, { vertical: true }))).toEqual([
      [3, 4],
      [1, 2],
    ])
  })

  it("mirrors both at once and is a detaching no-op for neither", () => {
    expect(redGrid(flipBuffer(source, { horizontal: true, vertical: true }))).toEqual([
      [4, 3],
      [2, 1],
    ])
    const same = flipBuffer(source, {})
    expect(same).not.toBe(source)
    expect(redGrid(same)).toEqual(redGrid(source))
  })
})

describe("rotateBuffer", () => {
  it("keeps the original frame size", () => {
    const source = gridBuffer([
      [1, 2, 3],
      [4, 5, 6],
    ])
    expect(rotateBuffer(source, 30)).toMatchObject({ width: 3, height: 2 })
  })

  it("routes exact quarter turns away from the resampler", () => {
    const square = gridBuffer([
      [1, 2],
      [3, 4],
    ])
    expect(redGrid(rotateBuffer(square, 90))).toEqual(redGrid(rotateQuarterTurns(square, 1)))
  })

  it("is a detaching no-op at a full turn", () => {
    const source = gridBuffer([[7]])
    const result = rotateBuffer(source, 360)
    expect(result).not.toBe(source)
    expect(redGrid(result)).toEqual([[7]])
  })
})

describe("transformBuffer", () => {
  it("applies flips before the crop", () => {
    const source = gridBuffer([
      [1, 2],
      [3, 4],
    ])
    const result = transformBuffer(source, {
      flipHorizontal: true,
      cropRegion: { x: 0, y: 0, width: 1, height: 2 },
    })
    expect(redGrid(result)).toEqual([[2], [4]])
  })

  it("scales about the centre without changing the frame", () => {
    const source = gridBuffer([
      [10, 20, 30, 40],
      [10, 20, 30, 40],
      [10, 20, 30, 40],
      [10, 20, 30, 40],
    ])
    const result = transformBuffer(source, { scale: 2 })
    expect(result).toMatchObject({ width: 4, height: 4 })
  })

  it("is a detaching no-op for empty options", () => {
    const source = gridBuffer([[5]])
    const result = transformBuffer(source, {})
    expect(result).not.toBe(source)
    expect(redGrid(result)).toEqual([[5]])
  })
})
