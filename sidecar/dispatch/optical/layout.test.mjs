import { test } from "node:test"
import assert from "node:assert/strict"

import {
  visionFamily,
  estimateImageTokens,
  frameGrid,
  selectShape,
  paginateCells,
  planOpticalFrames,
  wrapForDoc,
} from "./layout.mjs"
import { DIM_ON, DIM_OFF } from "./constants.mjs"

const ON = String.fromCharCode(DIM_ON)
const OFF = String.fromCharCode(DIM_OFF)

test("visionFamily maps model ids to pricing families", () => {
  assert.equal(visionFamily("claude-opus-4-8"), "anthropic")
  assert.equal(visionFamily("gpt-4o"), "openai")
  assert.equal(visionFamily("gemini-2.5-pro"), "google")
  assert.equal(visionFamily("some-local-model"), "default")
})

test("estimateImageTokens grows with area and differs per family", () => {
  assert.ok(
    estimateImageTokens(1024, 1024, "anthropic") > estimateImageTokens(512, 512, "anthropic")
  )
  assert.equal(estimateImageTokens(512, 512, "openai"), 85 + 170) // one 512 tile
  assert.equal(estimateImageTokens(1024, 1024, "openai"), 85 + 170 * 4)
  assert.equal(estimateImageTokens(300, 300, "google"), 258)
  assert.ok(estimateImageTokens(1000, 1000, "anthropic") <= 1600, "anthropic estimate is capped")
})

test("selectShape picks the family preset and honours overrides", () => {
  assert.deepEqual(selectShape({ modelId: "claude-x" }), {
    family: "anthropic",
    font: "8x8",
    variant: "bw",
  })
  const openai = selectShape({ modelId: "gpt-4o" })
  assert.equal(openai.cellWidth, 6)
  const overridden = selectShape({
    modelId: "claude-x",
    overrides: { variant: "sent", font: "5x8" },
  })
  assert.equal(overridden.variant, "sent")
  assert.equal(overridden.font, "5x8")
})

test("frameGrid computes capacity for grid and two-column doc", () => {
  const grid = frameGrid({ font: "8x8" }, 512)
  assert.equal(grid.capacity, 64 * 64)
  const doc = frameGrid({ font: "8x8", columns: 2 }, 512)
  // cols 64, colW = (64-3)/2 = 30, rows 64 → 30*64*2.
  assert.equal(doc.capacity, 30 * 64 * 2)
})

test("paginateCells splits at capacity, doubling wide cells and balancing dim spans", () => {
  assert.deepEqual(paginateCells("abcdef", 3), ["abc", "def"])
  // A wide char takes two cells: "a中" fills a capacity-3 frame exactly.
  assert.equal(paginateCells("a中", 3).length, 1)
  assert.equal(paginateCells("a中b", 3).length, 2, "b overflows to a second frame")
  assert.equal(paginateCells("a中中b", 3).length, 2)
  // A dim span that straddles the cut is closed and reopened.
  const split = paginateCells(`${ON}abcdef${OFF}`, 3)
  assert.equal(split.length, 2)
  assert.ok(split[0].startsWith(ON) && split[0].endsWith(OFF), "first chunk closes the span")
  assert.ok(split[1].startsWith(ON), "second chunk reopens the span")
})

test("planOpticalFrames fits frames, flags overflow, and judges worthwhile", () => {
  // Long text over many frames of a tiny grid.
  const long = "x".repeat(5000)
  const plan = planOpticalFrames({ text: long, modelId: "claude-x", size: 256, maxFrames: 2 })
  assert.equal(plan.frames.length, 2)
  assert.ok(plan.overflow, "5000 chars exceed two 256px frames")
  assert.equal(plan.family, "anthropic")

  // A big archive that comfortably fits one frame should be worthwhile.
  const fits = planOpticalFrames({
    text: "y".repeat(3000),
    modelId: "claude-x",
    size: 512,
    maxFrames: 4,
  })
  assert.ok(fits.frames.length >= 1 && !fits.overflow)
  assert.ok(fits.worthwhile, "packing 3000 chars into one small frame beats the text tokens")

  // A tiny transcript is NOT worthwhile (image tokens exceed the text tokens).
  const tiny = planOpticalFrames({ text: "hello there", modelId: "claude-x", size: 512 })
  assert.ok(!tiny.worthwhile, "a few words should stay as text")
})

test("wrapForDoc greedily wraps words and hard-splits over-long words", () => {
  assert.equal(wrapForDoc("the quick brown fox", 9), "the quick\nbrown fox")
  assert.equal(wrapForDoc("supercalifragilistic", 6), "superc\nalifra\ngilist\nic")
})
