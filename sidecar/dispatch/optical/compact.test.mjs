import { test } from "node:test"
import assert from "node:assert/strict"

import { buildOpticalCompaction } from "./compact.mjs"
import {
  isSummaryMessage,
  isOpticalMessage,
  summaryVersion,
  makeOpticalMessage,
} from "../compaction.mjs"

// A middle of substantial ASCII dialogue so optical is worthwhile.
function makeMiddle(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant"
    out.push({
      role,
      content: `message ${i}: the assistant refactored the authentication module to use rotating refresh tokens and updated the related unit tests across several files without regressions today`,
    })
  }
  return out
}

test("makeOpticalMessage is recognized as a frozen optical artifact", () => {
  const parts = [{ type: "image", image: "data:image/png;base64,AAAA", mediaType: "image/png" }]
  const msg = makeOpticalMessage(parts, { messageCount: 5, frameCount: 1 }, 3)
  assert.ok(isSummaryMessage(msg), "optical message is frozen like a summary")
  assert.ok(isOpticalMessage(msg), "and flagged as optical (image-bearing)")
  assert.equal(summaryVersion(msg), 3)
  assert.equal(msg.content[0].type, "text")
  assert.equal(msg.content[1].type, "image")
})

test("renders an optical archive when worthwhile (verify off)", async () => {
  const middle = makeMiddle(30)
  const result = await buildOpticalCompaction({
    middle,
    modelId: "claude-opus-4-8",
    version: 1,
    options: { size: 512, verify: false },
  })
  assert.ok(result, "produces an archive")
  assert.ok(isOpticalMessage(result.message))
  assert.ok(result.meta.frameCount >= 1)
  assert.ok(result.meta.frames.length === result.meta.frameCount)
  assert.ok(result.meta.frames[0].base64.length > 0)
  assert.equal(result.meta.coverage, 1)
  assert.ok(result.meta.estImageTokens < result.meta.estTextTokens, "cheaper than text")
})

test("falls back (null) when the transcript is CJK-heavy (low coverage)", async () => {
  const middle = [{ role: "user", content: "中文对话内容占绝大多数不能被点阵字体渲染".repeat(20) }]
  const result = await buildOpticalCompaction({
    middle,
    modelId: "claude-x",
    version: 1,
    options: { size: 512, verify: false, minCoverage: 0.7 },
  })
  assert.equal(result, null)
})

test("falls back when a tiny transcript is not worthwhile", async () => {
  const result = await buildOpticalCompaction({
    middle: [{ role: "user", content: "hi there" }],
    modelId: "claude-x",
    version: 1,
    options: { size: 512, verify: false },
  })
  assert.equal(result, null, "a few words stay as text")
})

test("falls back when the archive overflows the frame budget", async () => {
  const result = await buildOpticalCompaction({
    middle: makeMiddle(200),
    modelId: "claude-x",
    version: 1,
    options: { size: 128, maxFrames: 1, verify: false },
  })
  assert.equal(result, null, "too much text for one small frame → text summary")
})

test("round-trip: keeps a readable frame, falls back on an unreadable one", async () => {
  const middle = makeMiddle(30)
  const allWords = middle.map((m) => m.content).join(" ")

  const readable = await buildOpticalCompaction({
    middle,
    modelId: "claude-x",
    version: 2,
    options: { size: 512, verify: true, readabilityThreshold: 0.6 },
    transcribe: async () => allWords, // model "reads back" all the words
  })
  assert.ok(readable, "readable frame is kept")
  assert.ok(readable.meta.readability >= 0.6)

  const unreadable = await buildOpticalCompaction({
    middle,
    modelId: "claude-x",
    version: 2,
    options: { size: 512, verify: true, readabilityThreshold: 0.6 },
    transcribe: async () => "zzz qqq vvv nonsense", // garbage OCR
  })
  assert.equal(unreadable, null, "unreadable frame falls back to text summary")
})

test("verify failure (transcribe throws) falls back gracefully", async () => {
  const result = await buildOpticalCompaction({
    middle: makeMiddle(30),
    modelId: "claude-x",
    version: 1,
    options: { size: 512, verify: true },
    transcribe: async () => {
      throw new Error("vision provider down")
    },
  })
  assert.equal(result, null)
})
