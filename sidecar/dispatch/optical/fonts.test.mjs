import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseHex,
  parseBdf,
  resolveFont,
  fontSupports,
  supportedChars,
  AVAILABLE_FONTS,
} from "./fonts.mjs"
import { UNSCII_8_HEX, MISC_5X8_BDF } from "./fonts-data.mjs"

test("8x8 hex font parses full printable ASCII with ascent 7", () => {
  const font = parseHex(UNSCII_8_HEX)
  assert.equal(font.ascent, 7)
  assert.equal(font.cellW, 8)
  assert.equal(font.cellH, 8)
  for (let cp = 0x20; cp < 0x7f; cp++) {
    assert.ok(font.glyphs.has(cp), `missing 8x8 glyph U+${cp.toString(16)}`)
  }
  const A = font.glyphs.get(0x41)
  assert.equal(A.w, 8)
  assert.equal(A.rows.length, 8)
})

test("5x8 BDF font parses printable ASCII, ascent 7, width 5", () => {
  const font = parseBdf(MISC_5X8_BDF, 5, 8)
  assert.equal(font.ascent, 7)
  assert.equal(font.cellW, 5)
  assert.equal(font.cellH, 8)
  for (let cp = 0x20; cp < 0x7f; cp++) {
    assert.ok(font.glyphs.has(cp), `missing 5x8 glyph U+${cp.toString(16)}`)
  }
  // BBX width is clamped to ≤ 8 and captured; 'A' is 5px wide in this font.
  const A = font.glyphs.get(0x41)
  assert.equal(A.w, 5)
})

test("resolveFont caches and only knows the embedded fonts", () => {
  assert.deepEqual(AVAILABLE_FONTS, ["8x8", "5x8"])
  const a = resolveFont("8x8")
  const b = resolveFont("8x8")
  assert.equal(a, b, "same font instance returned (parse-once cache)")
  assert.ok(resolveFont("5x8"))
  assert.equal(resolveFont("6x12"), null, "un-embedded fonts resolve to null")
  assert.equal(resolveFont("silver"), null)
})

test("fontSupports treats control codes as renderable", () => {
  const font = resolveFont("8x8")
  for (const cc of [0x0e, 0x0f, 0x2588, 0x0a]) {
    assert.ok(fontSupports(font, cc), `control U+${cc.toString(16)} must be renderable`)
  }
  assert.ok(fontSupports(font, 0x41))
  assert.ok(!fontSupports(font, 0x4e2d), "CJK 中 not in Latin-1 font")
})

test("supportedChars keeps renderable chars and control codes, drops the rest", () => {
  // ASCII stays; a CJK char is dropped; the full-block control code stays.
  assert.equal(supportedChars("8x8", "ab█中c"), "ab█c")
  assert.throws(() => supportedChars("nope", "x"), /Unknown optical font/)
})
