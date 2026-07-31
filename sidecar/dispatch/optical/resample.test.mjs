import { test } from "node:test"
import assert from "node:assert/strict"

import { lanczos3, contributions, resizeRgb } from "./resample.mjs"

test("lanczos3 kernel: peak at 0, zero past support, symmetric", () => {
  assert.equal(lanczos3(0), 1)
  assert.equal(lanczos3(3), 0)
  assert.equal(lanczos3(5), 0)
  assert.ok(Math.abs(lanczos3(1) - lanczos3(-1)) < 1e-9, "even function")
  assert.ok(lanczos3(1.5) < 0, "first negative lobe")
})

test("contributions weights are normalized per output pixel", () => {
  for (const [src, dst] of [
    [8, 8],
    [8, 4],
    [4, 8],
    [13, 6],
  ]) {
    for (const [, weights] of contributions(src, dst)) {
      const sum = weights.reduce((a, b) => a + b, 0)
      assert.ok(Math.abs(sum - 1) < 1e-5, `weights sum to 1 for ${src}->${dst}`)
    }
  }
})

test("resizeRgb preserves a constant color under up/down scaling", () => {
  // 2x2 solid mid-gray → resize to 5x3 stays ~gray everywhere.
  const sw = 2
  const sh = 2
  const src = new Float32Array(sw * sh * 3).fill(128)
  const out = resizeRgb(src, sw, sh, 5, 3)
  assert.equal(out.length, 5 * 3 * 3)
  for (const v of out) assert.ok(Math.abs(v - 128) < 1e-3, "constant field is preserved")
})

test("resizeRgb identity keeps the source (Lanczos interpolates exactly)", () => {
  const sw = 4
  const sh = 1
  const src = new Float32Array([0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255])
  const out = resizeRgb(src, sw, sh, sw, sh)
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(out[i] - src[i]) < 1e-3)
})
