import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveFont } from "./fonts.mjs"
import { renderBitmap, renderDocBitmap, usedRows, placeCell, cellUnits, isWide } from "./raster.mjs"
import { INK_BLACK, BG_REPEAT, INK_DIM, DIM_ON, DIM_OFF, FULL_BLOCK } from "./constants.mjs"

const F8 = resolveFont("8x8")
const F5 = resolveFont("5x8")
const inkSet = (px) => new Set([...px].filter((p) => p !== 0))

test("cell geometry: dim toggles zero-width, wide code points double", () => {
  assert.equal(cellUnits(DIM_ON, true), 0)
  assert.equal(cellUnits(0x41, true), 1)
  assert.equal(cellUnits(0x4e2d, true), 2) // 中 is wide
  assert.equal(cellUnits(0x4e2d, false), 1)
  assert.ok(isWide(0x4e2d) && isWide(0xac00) && !isWide(0x41))
  // straddle pad: a wide glyph at the last column starts the next row.
  assert.deepEqual(placeCell(7, 8, 0x4e2d, true), [8, 2, 10])
  assert.equal(placeCell(0, 8, DIM_ON, true), null)
})

test("grid: sentence hues cycle and capacity is capped without panic", () => {
  const grid = { cols: 8, rows: 5, repeat: 1, cellW: 5, cellH: 8 }
  const px = renderBitmap("Hi. Ok.", 40, 40, F5, grid, false)
  const inks = inkSet(px)
  assert.ok(inks.has(1), "first sentence ink 1")
  assert.ok(inks.has(2), "second sentence ink 2")
  assert.ok(!inks.has(3), "no third sentence")
  // Overflow stays in-bounds.
  const overflow = renderBitmap("x".repeat(100), 40, 40, F5, grid, false)
  assert.equal(overflow.length, 40 * 40)
})

test("bw variant inks only black", () => {
  const grid = { cols: 8, rows: 8, repeat: 1, cellW: 8, cellH: 8 }
  const px = renderBitmap("Hi. Ok.", 64, 64, F8, grid, true)
  const inks = [...inkSet(px)]
  assert.ok(inks.length > 0)
  assert.ok(
    inks.every((p) => p === INK_BLACK),
    "bw inks only black"
  )
})

test("dim markers toggle gray without consuming cells", () => {
  const grid = { cols: 8, rows: 8, repeat: 1, cellW: 8, cellH: 8 }
  const px = renderBitmap("ABCD", 64, 64, F8, grid, true)
  const inks = inkSet(px)
  assert.ok(inks.has(INK_DIM), "dim span inks gray")
  assert.ok(inks.has(INK_BLACK), "post-span returns to black")
  // Layout is identical with and without the zero-width markers.
  const plain = renderBitmap("ABCD", 64, 64, F8, grid, true)
  for (let i = 0; i < px.length; i++) {
    assert.equal(px[i] !== 0, plain[i] !== 0, `layout must ignore markers (pixel ${i})`)
  }
})

test("line repeat duplicates rows on highlight bands", () => {
  const grid = { cols: 8, rows: 4, repeat: 2, cellW: 8, cellH: 8 }
  const px = renderBitmap("ABCDEFGH", 64, 64, F8, grid, true)
  assert.ok([...px.slice(9 * 64, 10 * 64)].includes(BG_REPEAT), "copy band is highlighted")
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 64; x++) {
      const a = px[y * 64 + x]
      const b = px[(y + 8) * 64 + x]
      assert.equal(a === INK_BLACK, b === INK_BLACK, `copy ink mismatch (${x},${y})`)
    }
  }
})

test("full block fills its cell pitch-black over dim and hue", () => {
  const grid = { cols: 8, rows: 4, repeat: 2, cellW: 8, cellH: 8 }
  const px = renderBitmap("a█b", 64, 64, F8, grid, false)
  for (let copy = 0; copy < 2; copy++) {
    for (let y = copy * 8; y < (copy + 1) * 8; y++) {
      for (let x = 8; x < 16; x++) {
        assert.equal(px[y * 64 + x], INK_BLACK, `block pixel (${x},${y})`)
      }
    }
  }
  assert.ok(inkSet(px).has(INK_DIM), "neighbours keep dim ink")
  const hued = renderBitmap("Hi.█Ok.", 64, 64, F8, grid, false)
  assert.ok(inkSet(hued).has(2), "block advances the sentence hue like a space")
})

test("doc layout flows lines into the second column with a blank gutter", () => {
  const grid = { cols: 8, rows: 4, repeat: 1, cellW: 8, cellH: 8 }
  const px = renderDocBitmap("A\nB\nC\nD\nE", 64, 32, F8, grid, true)
  // col_w = (8-3)/2 = 2; fifth line lands at the second column's x origin 40.
  const col2 = [...Array(8).keys()].some((y) =>
    [...Array(8).keys()].some((k) => px[y * 64 + (40 + k)] === INK_BLACK)
  )
  assert.ok(col2, "fifth line starts at the second column")
  // The gutter between columns stays blank.
  for (let y = 0; y < 32; y++) {
    for (let x = 16; x < 40; x++) assert.equal(px[y * 64 + x], 0, `gutter blank (${x},${y})`)
  }
})

test("doc sentence hue advances across newline; grid mode does not", () => {
  const grid = { cols: 19, rows: 4, repeat: 1, cellW: 8, cellH: 8 }
  const doc = inkSet(renderDocBitmap("Hi.\nOk", 152, 32, F8, grid, false))
  assert.ok(doc.has(1) && doc.has(2), "doc advances hue across newline")
  assert.ok(!doc.has(3))
  const gridMode = inkSet(renderBitmap("Hi.\nOk", 152, 32, F8, grid, false))
  assert.ok(gridMode.has(1) && !gridMode.has(2), "grid mode does not advance across newline")
})

test("usedRows hugs content and clamps to the grid", () => {
  const grid = { cols: 8, rows: 8, repeat: 1, cellW: 8, cellH: 8 }
  assert.equal(usedRows("0123456789", grid, false, true), 2) // 10 chars / 8 cols
  assert.equal(usedRows("01234567", grid, false, true), 1) // dim zero-width
  assert.equal(usedRows("x".repeat(200), grid, false, true), 8) // clamped
  assert.equal(usedRows("a\nb\nc", grid, true, true), 3) // doc counts lines
})
