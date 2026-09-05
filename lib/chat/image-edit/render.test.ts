import { createPixelBuffer, type PixelBuffer } from "@/lib/images"

import {
  previewScaleFor,
  renderOperations,
  renderPipeline,
  resolveSaveEncoding,
  scaleOperations,
  PREVIEW_MAX_LONG_EDGE,
} from "./render"
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

describe("previewScaleFor", () => {
  it("leaves an already-small image alone", () => {
    expect(previewScaleFor({ width: 400, height: 300 })).toBe(1)
  })

  it("fits the long edge to the preview ceiling", () => {
    expect(previewScaleFor({ width: 1800, height: 600 })).toBeCloseTo(
      PREVIEW_MAX_LONG_EDGE / 1800,
      6
    )
    expect(previewScaleFor({ width: 600, height: 1800 })).toBeCloseTo(
      PREVIEW_MAX_LONG_EDGE / 1800,
      6
    )
  })

  it("honours an explicit ceiling", () => {
    expect(previewScaleFor({ width: 400, height: 400 }, 200)).toBe(0.5)
  })
})

describe("scaleOperations", () => {
  const operations: LocalEntry[] = [
    { kind: "crop", rect: { x: 100, y: 50, width: 400, height: 200 } },
    { kind: "resize", width: 800, height: 400 },
    { kind: "rotate", turns: 1 },
    { kind: "flip", horizontal: true, vertical: false },
    { kind: "adjust", adjustments: { brightness: 10 }, gestureId: "g" },
  ]

  it("returns a copy at factor 1 without touching anything", () => {
    expect(scaleOperations(operations, 1)).toEqual(operations)
  })

  it("scales every geometric step by the same factor", () => {
    // Scaling a crop but not the resize before it would select the wrong
    // region, because the crop's coordinates are relative to that resize.
    const scaled = scaleOperations(operations, 0.5)
    expect(scaled[0]).toMatchObject({ rect: { x: 50, y: 25, width: 200, height: 100 } })
    expect(scaled[1]).toMatchObject({ width: 400, height: 200 })
  })

  it("passes scale-free steps through unchanged", () => {
    const scaled = scaleOperations(operations, 0.5)
    expect(scaled[2]).toEqual(operations[2])
    expect(scaled[3]).toEqual(operations[3])
    expect(scaled[4]).toEqual(operations[4])
  })

  it("never scales a dimension to zero", () => {
    const scaled = scaleOperations(
      [{ kind: "crop", rect: { x: 0, y: 0, width: 3, height: 3 } }],
      0.01
    )
    expect(scaled[0]).toMatchObject({ rect: { width: 1, height: 1 } })
  })
})
