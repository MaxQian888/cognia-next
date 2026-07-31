import { test } from "node:test"
import assert from "node:assert/strict"
import { inflateSync } from "node:zlib"

import { encodeIndexedPng, encodeRgbPng } from "./png.mjs"
import { PALETTE, INK_BLACK, INK_DIM, BG_REPEAT } from "./constants.mjs"

// Minimal PNG reader for the tests: parse chunks, verify CRCs implicitly by
// re-reading structure, inflate IDAT, unpack scanlines.
function parsePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature")
  let off = 8
  const out = { idat: [] }
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString("latin1", off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === "IHDR") {
      out.width = data.readUInt32BE(0)
      out.height = data.readUInt32BE(4)
      out.bitDepth = data[8]
      out.colorType = data[9]
    } else if (type === "PLTE") {
      out.palette = []
      for (let i = 0; i < data.length; i += 3) out.palette.push([data[i], data[i + 1], data[i + 2]])
    } else if (type === "IDAT") {
      out.idat.push(data)
    }
    off += 12 + len
  }
  out.idat = Buffer.concat(out.idat)
  return out
}

// Decode indexed pixels back to RGB triples via the parsed palette.
function decodeIndexedToRgb(png) {
  const raw = inflateSync(png.idat)
  const per = 8 / png.bitDepth
  const rowBytes = Math.ceil(png.width / per)
  const stride = 1 + rowBytes
  const mask = (1 << png.bitDepth) - 1
  const rgb = []
  for (let y = 0; y < png.height; y++) {
    assert.equal(raw[y * stride], 0, "None filter byte")
    for (let x = 0; x < png.width; x++) {
      const byte = raw[y * stride + 1 + Math.floor(x / per)]
      const slot = (byte >> (png.bitDepth * (per - 1 - (x % per)))) & mask
      rgb.push(png.palette[slot])
    }
  }
  return rgb
}

test("indexed PNG round-trips pixels through the narrowed palette", () => {
  // 4x2: white bg with two black inks. Only {white, black} used → 1-bit.
  const w = 4
  const h = 2
  const px = new Uint8Array([0, INK_BLACK, 0, 0, INK_BLACK, INK_BLACK, 0, 0])
  const png = parsePng(encodeIndexedPng(px, w, h))
  assert.equal(png.colorType, 3, "indexed")
  assert.equal(png.bitDepth, 1, "bg+ink packs to 1-bit")
  assert.equal(png.palette.length, 2)
  const rgb = decodeIndexedToRgb(png)
  assert.deepEqual(rgb[0], [255, 255, 255], "index 0 → white")
  assert.deepEqual(rgb[1], PALETTE[INK_BLACK], "INK_BLACK → black")
  assert.deepEqual(rgb[4], PALETTE[INK_BLACK])
})

test("bit depth follows the color count (2-bit for dim/band, 4-bit for hues)", () => {
  // 4 colors → 2-bit.
  const four = new Uint8Array([0, INK_BLACK, INK_DIM, BG_REPEAT])
  assert.equal(parsePng(encodeIndexedPng(four, 4, 1)).bitDepth, 2)
  // 5 colors → 4-bit (bg + four sentence hues).
  const five = new Uint8Array([0, 1, 2, 3, 4])
  assert.equal(parsePng(encodeIndexedPng(five, 5, 1)).bitDepth, 4)
  // Single color (all bg) → 1-bit, palette length 1.
  const one = new Uint8Array([0, 0, 0])
  const png = parsePng(encodeIndexedPng(one, 3, 1))
  assert.equal(png.bitDepth, 1)
  assert.equal(png.palette.length, 1)
})

test("RGB PNG round-trips truecolor scanlines", () => {
  const w = 2
  const h = 2
  const px = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const png = parsePng(encodeRgbPng(px, w, h))
  assert.equal(png.colorType, 2)
  assert.equal(png.bitDepth, 8)
  const raw = inflateSync(png.idat)
  // stride = 1 + w*3; each row starts with a 0 filter byte.
  assert.equal(raw[0], 0)
  assert.deepEqual([...raw.subarray(1, 7)], [1, 2, 3, 4, 5, 6])
  assert.equal(raw[7], 0)
  assert.deepEqual([...raw.subarray(8, 14)], [7, 8, 9, 10, 11, 12])
})
