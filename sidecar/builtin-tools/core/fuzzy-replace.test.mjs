import { test } from "node:test"
import assert from "node:assert/strict"

import { replaceWithFallback, similarity, ReplaceError } from "./fuzzy-replace.mjs"

test("exact match replaces a unique occurrence", () => {
  const r = replaceWithFallback("alpha beta gamma", "beta", "BETA")
  assert.equal(r.content, "alpha BETA gamma")
  assert.equal(r.matched, "exact")
  assert.equal(r.count, 1)
})

test("exact multi-match without replace_all throws not_unique", () => {
  assert.throws(
    () => replaceWithFallback("x y x", "x", "z"),
    (e) => e instanceof ReplaceError && e.code === "not_unique"
  )
})

test("replace_all replaces every exact occurrence", () => {
  const r = replaceWithFallback("x y x y x", "x", "z", true)
  assert.equal(r.content, "z y z y z")
  assert.equal(r.count, 3)
})

test("line-trimmed fallback tolerates leading/trailing whitespace drift", () => {
  const content = "function a() {\n    return 1\n}\n"
  const r = replaceWithFallback(
    content,
    "function a() {\nreturn 1\n}",
    "function a() {\n    return 2\n}"
  )
  assert.equal(r.matched, "line-trimmed")
  assert.ok(r.content.includes("return 2"))
})

test("whitespace-normalized fallback tolerates inner whitespace drift", () => {
  const content = "const x  =   compute( a,   b )\nnext\n"
  const r = replaceWithFallback(content, "const x = compute( a, b )", "const x = compute(a, b, c)")
  assert.equal(r.matched, "whitespace-normalized")
  assert.ok(r.content.startsWith("const x = compute(a, b, c)"))
})

test("indentation-flexible fallback matches a uniformly dedented needle", () => {
  const content = "if (cond) {\n        doThing()\n        more()\n}\n"
  // Needle has the same lines but with 4-space indent instead of 8.
  const r = replaceWithFallback(content, "    doThing()\n    more()", "    replaced()")
  assert.ok(["indentation-flexible", "line-trimmed"].includes(r.matched))
  assert.ok(r.content.includes("replaced()"))
  assert.ok(!r.content.includes("doThing"))
})

test("block-anchor fallback survives a slightly different middle", () => {
  const content = ["start marker", "  middle line one", "  middle line two", "end marker"].join(
    "\n"
  )
  const needle = ["start marker", "  middle line 1", "  middle line 2", "end marker"].join("\n")
  const r = replaceWithFallback(content, needle, "REPLACED")
  assert.equal(r.matched, "block-anchor")
  assert.equal(r.content, "REPLACED")
})

test("block-anchor rejects a middle below the similarity threshold", () => {
  const content = ["start marker", "completely different content here", "end marker"].join("\n")
  const needle = ["start marker", "zzzz qqqq xxxx yyyy wwww", "end marker"].join("\n")
  assert.throws(
    () => replaceWithFallback(content, needle, "REPLACED"),
    (e) => e instanceof ReplaceError && e.code === "not_found"
  )
})

test("not_found when nothing matches at all", () => {
  assert.throws(
    () => replaceWithFallback("hello", "absent", "x"),
    (e) => e instanceof ReplaceError && e.code === "not_found"
  )
})

test("identical old/new strings are rejected", () => {
  assert.throws(() => replaceWithFallback("hello", "hello", "hello"), /identical/)
})

test("empty old_string is rejected", () => {
  assert.throws(() => replaceWithFallback("hello", "", "x"), /non-empty/)
})

test("similarity is 1 for equal, 0 for empty-vs-nonempty, symmetric-ish", () => {
  assert.equal(similarity("abc", "abc"), 1)
  assert.equal(similarity("", "abc"), 0)
  assert.ok(similarity("kitten", "sitting") > 0.5)
})
