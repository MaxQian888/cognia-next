// Minimal PNG encoding for the optical renderer. No image dependency — the
// sidecar has `zlib` built in, so we build IHDR/PLTE/IDAT/IEND by hand with
// `None` row filtering. Ports `pack_bits` / `encode_indexed_png` /
// `encode_rgb_png` from snapcompact.rs, including the palette-narrowing bit
// depth (1/2/4-bit) that shrinks the base64 that crosses the IPC boundary and
// lands in the archive.

import { deflateSync } from "node:zlib"
import { PALETTE } from "./constants.mjs"

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// CRC32 (PNG polynomial), table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "latin1")
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function ihdr(width, height, bitDepth, colorType) {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(width, 0)
  d.writeUInt32BE(height, 4)
  d.writeUInt8(bitDepth, 8)
  d.writeUInt8(colorType, 9)
  d.writeUInt8(0, 10) // compression
  d.writeUInt8(0, 11) // filter method
  d.writeUInt8(0, 12) // interlace
  return chunk("IHDR", d)
}

/**
 * Pack one-byte-per-pixel palette indices into `bits`-per-pixel scanlines,
 * prepending a `0` (None) filter byte per row and remapping each global palette
 * index through `remap`.
 */
function packIndexedScanlines(pixels, width, height, bits, remap) {
  const per = 8 / bits
  const rowBytes = Math.ceil(width / per)
  const stride = 1 + rowBytes
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const src = y * width
    const rowStart = y * stride // out[rowStart] = 0 (None filter)
    for (let x = 0; x < width; x++) {
      const val = remap[pixels[src + x]]
      out[rowStart + 1 + Math.floor(x / per)] |= val << (bits * (per - 1 - (x % per)))
    }
  }
  return out
}

/**
 * Encode a palette-indexed bitmap as an indexed PNG. The palette is narrowed to
 * the colors the frame actually uses and the bit depth follows: bg+ink → 1-bit,
 * dim/banded → 2-bit, sentence-hue → 4-bit.
 * @param {Uint8Array} pixels @returns {Buffer}
 */
export function encodeIndexedPng(pixels, width, height) {
  const used = new Array(PALETTE.length).fill(false)
  for (let i = 0; i < pixels.length; i++) used[pixels[i]] = true
  const remap = new Uint8Array(PALETTE.length)
  const palette = []
  let count = 0
  for (let g = 0; g < PALETTE.length; g++) {
    if (used[g]) {
      remap[g] = count++
      palette.push(PALETTE[g][0], PALETTE[g][1], PALETTE[g][2])
    }
  }
  const [depth, bits] = count <= 2 ? [1, 1] : count <= 4 ? [2, 2] : [4, 4]
  const scan = packIndexedScanlines(pixels, width, height, bits, remap)
  const idat = deflateSync(Buffer.from(scan.buffer, scan.byteOffset, scan.byteLength), { level: 9 })
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, depth, 3),
    chunk("PLTE", Buffer.from(palette)),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * Encode an interleaved RGB8 buffer as a truecolor PNG (`None` filtering).
 * @param {Uint8Array} pixels @returns {Buffer}
 */
export function encodeRgbPng(pixels, width, height) {
  const stride = 1 + width * 3
  const scan = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    scan.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1)
  }
  const idat = deflateSync(Buffer.from(scan.buffer, scan.byteOffset, scan.byteLength), { level: 9 })
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, 8, 2),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
