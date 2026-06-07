import { test } from "node:test"
import assert from "node:assert/strict"
import { getPath, parsePath } from "./json-path-lite.mjs"

test("parsePath splits dot segments and numeric brackets", () => {
  assert.deepEqual(parsePath("choices[0].delta.content"), ["choices", 0, "delta", "content"])
  assert.deepEqual(parsePath("usage.prompt_tokens"), ["usage", "prompt_tokens"])
  assert.deepEqual(parsePath("a[1][2]"), ["a", 1, 2])
})

test("parsePath rejects malformed paths", () => {
  assert.equal(parsePath(""), null)
  assert.equal(parsePath(null), null)
  assert.equal(parsePath("a..b"), null)
  assert.equal(parsePath("a[b]"), null)
  assert.equal(parsePath("a["), null)
})

test("getPath resolves nested objects and arrays", () => {
  const obj = { choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 7 } }
  assert.equal(getPath(obj, "choices[0].delta.content"), "hi")
  assert.equal(getPath(obj, "usage.prompt_tokens"), 7)
})

test("getPath returns undefined on any miss", () => {
  const obj = { a: [{ b: 1 }] }
  assert.equal(getPath(obj, "a[1].b"), undefined)
  assert.equal(getPath(obj, "a[0].c"), undefined)
  assert.equal(getPath(obj, "x.y"), undefined)
  assert.equal(getPath(obj, "a.b"), undefined) // numeric access on array required
  assert.equal(getPath(null, "a"), undefined)
  assert.equal(getPath(obj, "a[0].b.c"), undefined) // descend past a primitive
})
