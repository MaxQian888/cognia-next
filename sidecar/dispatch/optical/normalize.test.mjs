import { test } from "node:test"
import assert from "node:assert/strict"

import { extractMessageText, normalizeForOptical } from "./normalize.mjs"
import { DIM_ON, DIM_OFF, FULL_BLOCK } from "./constants.mjs"

const BLOCK = String.fromCodePoint(FULL_BLOCK)
const ON = String.fromCharCode(DIM_ON)
const OFF = String.fromCharCode(DIM_OFF)

test("extractMessageText pulls text from strings, parts, and tool bodies", () => {
  assert.equal(extractMessageText("hi"), "hi")
  assert.equal(extractMessageText([{ type: "text", text: "a" }, "b"]), "ab")
  assert.equal(extractMessageText([{ type: "tool-result", output: "res" }]), "res")
  assert.equal(
    extractMessageText([{ type: "tool-result", output: [{ text: "x" }, { text: "y" }] }]),
    "xy"
  )
  assert.equal(extractMessageText([{ type: "tool-result", result: { a: 1 } }]), '{"a":1}')
})

test("normalizeForOptical prefixes roles and folds newlines to full-block in grid mode", () => {
  const { text } = normalizeForOptical(
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
    { columns: 1 }
  )
  assert.ok(text.includes("user: hello"))
  assert.ok(text.includes("assistant: world"))
  assert.ok(text.includes(BLOCK), "grid mode folds the message break to a full block")
  assert.ok(!text.includes("\n"), "no raw newlines survive grid normalization")
})

test("normalizeForOptical keeps newlines as separators in doc mode", () => {
  const { text } = normalizeForOptical(
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    { columns: 2 }
  )
  assert.ok(text.includes("\n"), "doc mode keeps newline line separators")
  assert.ok(!text.includes(BLOCK))
})

test("tool output is wrapped in dim spans", () => {
  const { text } = normalizeForOptical([{ role: "tool", content: "noisy tool output" }])
  assert.ok(text.includes(`${ON}noisy tool output${OFF}`), "tool body reads dim")
})

test("coverage reports renderable fraction and replaces unsupported code points", () => {
  const ascii = normalizeForOptical([{ role: "user", content: "plain ascii" }])
  assert.equal(ascii.coverage, 1)

  const cjk = normalizeForOptical([{ role: "user", content: "hi 中文 world" }], {
    replacement: "?",
  })
  assert.ok(cjk.coverage < 1, "CJK lowers coverage")
  assert.ok(cjk.text.includes("?"), "unsupported code points become the replacement")
  assert.ok(!cjk.text.includes("中"))
  assert.equal(cjk.renderableCount + 2, cjk.charCount, "the two CJK chars are the only misses")
})
