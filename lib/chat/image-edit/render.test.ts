import { createPixelBuffer, type PixelBuffer } from "@/lib/images"

import { renderOperations, renderPipeline, resolveSaveEncoding } from "./render"
import type { LocalEntry } from "./editor-state"

function grid(rows: number[][]): PixelBuffer {
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

function reds(buffer: PixelBuffer): number[][] {
  const rows: number[][] = []
  for (let y = 0; y < buffer.height; y += 1) {
    const row: number[] = []
    for (let x = 0; x < buffer.width; x += 1) row.push(buffer.data[(y * buffer.width + x) * 4])
    rows.push(row)
  }
  return rows
}

const source = grid([
  [1, 2],
  [3, 4],
])

describe("renderOperations", () => {
  it("returns the base untouched when there is nothing to replay", () => {
    expect(renderOperations(source, [])).toBe(source)
  })

  it("applies each kind of step", () => {
    expect(
      reds(renderOperations(source, [{ kind: "flip", horizontal: true, vertical: false }]))
    ).toEqual([
      [2, 1],
      [4, 3],
    ])
    expect(renderOperations(source, [{ kind: "resize", width: 4, height: 4 }])).toMatchObject({
      width: 4,
      height: 4,
    })
    expect(reds(renderOperations(source, [{ kind: "rotate", turns: 1 }]))).toEqual([
      [3, 1],
      [4, 2],
    ])
    expect(
      reds(renderOperations(source, [{ kind: "crop", rect: { x: 0, y: 0, width: 1, height: 1 } }]))
    ).toEqual([[1]])
    expect(
      renderOperations(source, [
        { kind: "adjust", adjustments: { brightness: 20 }, gestureId: "g" },
      ]).data[0]
    ).toBeGreaterThan(1)
  })

  it("respects the order the user performed the steps in", () => {
    // A crop after a rotate selects a different region than the same crop
    // before it, so the pipeline cannot reorder for convenience.
    const rotateThenCrop: LocalEntry[] = [
      { kind: "rotate", turns: 1 },
      { kind: "crop", rect: { x: 0, y: 0, width: 1, height: 1 } },
    ]
    const cropThenRotate: LocalEntry[] = [
      { kind: "crop", rect: { x: 0, y: 0, width: 1, height: 1 } },
      { kind: "rotate", turns: 1 },
    ]
    expect(reds(renderOperations(source, rotateThenCrop))).toEqual([[3]])
    expect(reds(renderOperations(source, cropThenRotate))).toEqual([[1]])
  })

  it("does not mutate the base buffer", () => {
    const before = [...source.data]
    renderOperations(source, [{ kind: "adjust", adjustments: { brightness: 50 }, gestureId: "g" }])
    expect([...source.data]).toEqual(before)
  })
})

describe("renderPipeline", () => {
  it("replays the pipeline's operations onto the given base", () => {
    const result = renderPipeline(source, {
      baseCheckpointId: null,
      operations: [{ kind: "rotate", turns: 2 }],
    })
    expect(reds(result)).toEqual([
      [4, 3],
      [2, 1],
    ])
  })
})

describe("resolveSaveEncoding", () => {
  const opaque = grid([[10]])
  const transparent = createPixelBuffer(1, 1)

  it("keeps a model's own bytes when nothing was done to them", () => {
    expect(
      resolveSaveEncoding({ buffer: opaque, operationCount: 0, baseMediaType: "image/png" })
    ).toMatchObject({ reuseBaseBytes: true })
  })

  it("re-encodes as soon as a local step touched the model output", () => {
    expect(
      resolveSaveEncoding({ buffer: opaque, operationCount: 1, baseMediaType: "image/png" })
    ).toEqual({ reuseBaseBytes: false, format: "webp" })
  })

  it("defaults a locally edited photo to webp", () => {
    expect(resolveSaveEncoding({ buffer: opaque, operationCount: 2, baseMediaType: null })).toEqual(
      { reuseBaseBytes: false, format: "webp" }
    )
  })

  it("uses png when the result carries transparency", () => {
    // Otherwise a background removal is silently flattened onto black.
    expect(
      resolveSaveEncoding({ buffer: transparent, operationCount: 1, baseMediaType: null })
    ).toEqual({ reuseBaseBytes: false, format: "png" })
  })

  it("does not reuse base bytes when there is no base media type", () => {
    expect(
      resolveSaveEncoding({ buffer: opaque, operationCount: 0, baseMediaType: null })
    ).toMatchObject({ reuseBaseBytes: false })
  })
})
