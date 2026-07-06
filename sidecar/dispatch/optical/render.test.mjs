import { test } from "node:test"
import assert from "node:assert/strict"

import { renderSnapcompactPng } from "./render.mjs"

// IHDR fields live at fixed offsets: width@16, height@20, depth@24, colorType@25.
function header(frame) {
  const png = Buffer.from(frame.base64, "base64")
  assert.equal(png.length, frame.byteLength)
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    depth: png[24],
    colorType: png[25],
    paletteColors: (() => {
      const tag = png.indexOf(Buffer.from("PLTE"))
      return tag < 0 ? 0 : png.readUInt32BE(tag - 4) / 3
    })(),
  }
}

test("native-cell shapes encode indexed; stretched shapes encode RGB", () => {
  const native = renderSnapcompactPng("Hello world. Again.", {
    size: 128,
    font: "8x8",
    variant: "bw",
    lineRepeat: 2,
  })
  assert.equal(native.colorType, 3)
  assert.equal(header(native).colorType, 3)

  const stretched = renderSnapcompactPng("Hello world. Again.", {
    size: 128,
    font: "8x8",
    cellWidth: 6,
    cellHeight: 6,
  })
  assert.equal(stretched.colorType, 2, "6x6 target ≠ 8x8 natural → RGB stretch")

  const legacy = renderSnapcompactPng("Hi. Ok.", { size: 40, font: "5x8" })
  assert.equal(legacy.colorType, 3, "5x8 natural cell stays indexed")
})

test("stretch:false keeps bitmap fonts indexed on a padded pitch", () => {
  const frame = renderSnapcompactPng("Hello there. General Kenobi!", {
    size: 128,
    font: "5x8",
    cellWidth: 6,
    cellHeight: 10,
    stretch: false,
    variant: "bw",
  })
  assert.equal(frame.colorType, 3, "stretch:false pins the indexed path")
})

test("indexed PNG narrows palette + bit depth by content", () => {
  const bw = header(
    renderSnapcompactPng("Hello world. Again.", { size: 128, font: "8x8", variant: "bw" })
  )
  assert.equal(bw.depth, 1, "bg + black = 1-bit")
  assert.equal(bw.paletteColors, 2)

  const dim = header(
    renderSnapcompactPng("Read the dim part now.", {
      size: 128,
      font: "8x8",
      variant: "bw",
      lineRepeat: 2,
    })
  )
  assert.equal(dim.depth, 2, "bg + black + dim + band = 4 colors = 2-bit")

  const sent = header(renderSnapcompactPng("Hi. Ok.", { size: 128, font: "8x8", variant: "sent" }))
  assert.equal(sent.depth, 2, "bg + 2 hues fits 2-bit")
  assert.equal(sent.paletteColors, 3)
})

test("frame height hugs the rows the text actually uses", () => {
  const opt = (extra) => ({ size: 64, font: "8x8", ...extra })
  // 8 cols of 8x8 cells: 10 chars span 2 rows → 16px tall.
  assert.deepEqual(dims(renderSnapcompactPng("0123456789", opt())), [64, 16])
  // Dim toggles are zero-width and add no row.
  assert.deepEqual(dims(renderSnapcompactPng("01234567", opt())), [64, 8])
  // Capacity-filling text keeps the full grid height.
  assert.deepEqual(dims(renderSnapcompactPng("x".repeat(64), opt())), [64, 64])
  // Repeat shapes hug usedRows*repeat copy bands.
  assert.deepEqual(dims(renderSnapcompactPng("0123456789", opt({ lineRepeat: 2 }))), [64, 32])
  // The stretch path hugs too (6x6 target cells, RGB output).
  assert.deepEqual(
    dims(
      renderSnapcompactPng("0123456789ab", { size: 60, font: "8x8", cellWidth: 6, cellHeight: 6 })
    ),
    [60, 12]
  )

  function dims(frame) {
    const h = header(frame)
    return [h.width, h.height]
  }
})

test("two-column doc layout renders and validates columns", () => {
  const doc = renderSnapcompactPng("Hello there.\nSecond line", {
    size: 256,
    font: "5x8",
    cellWidth: 6,
    cellHeight: 10,
    stretch: false,
    columns: 2,
  })
  assert.equal(doc.colorType, 3, "8on-style doc frame stays indexed")
  assert.throws(() => renderSnapcompactPng("x", { size: 64, columns: 3 }), /expected 1 or 2/)
})

test("rejects bad shapes", () => {
  assert.throws(() => renderSnapcompactPng("x", { size: 0 }), /Invalid frame size/)
  assert.throws(() => renderSnapcompactPng("x", { size: 64, font: "9x9" }), /Unknown optical font/)
  assert.throws(
    () => renderSnapcompactPng("x", { size: 64, variant: "zebra" }),
    /Unknown optical variant/
  )
  assert.throws(
    () => renderSnapcompactPng("x", { size: 4, cellWidth: 9999 }),
    /cannot fit/,
    "grid that can't fit one cell is rejected"
  )
})
