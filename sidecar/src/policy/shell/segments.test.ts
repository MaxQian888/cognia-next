import { test } from "node:test"
import assert from "node:assert/strict"

import { extractSubstitutions, matchParen, splitTopLevel } from "./segments.ts"

test("splitTopLevel splits on every statement separator outside quotes", () => {
  assert.deepEqual(splitTopLevel("a && b || c; d | e & f\ng"), ["a", "b", "c", "d", "e", "f", "g"])
  assert.deepEqual(splitTopLevel(`git commit -m "a; b" && echo 'x|y'`), [
    `git commit -m "a; b"`,
    "echo 'x|y'",
  ])
  assert.deepEqual(splitTopLevel("echo `a; b`; c"), ["echo `a; b`", "c"])
})

test("splitTopLevel keeps parenthesized groups whole", () => {
  assert.deepEqual(splitTopLevel("(cd a && make) && ls"), ["(cd a && make)", "ls"])
  assert.deepEqual(splitTopLevel("   "), [])
})

test("matchParen skips quoted parentheses", () => {
  assert.equal(matchParen("(a ')' b)", 0), 8)
  assert.equal(matchParen('(a "(" (b))', 0), 10)
  assert.equal(matchParen("(unclosed", 0), -1)
})

test("extractSubstitutions surfaces $(), backtick and subshell commands", () => {
  const { inner, stripped } = extractSubstitutions("echo $(git push) `rm x` (ls) 'no $(y)'")
  assert.deepEqual(inner, ["git push", "rm x", "ls"])
  assert.equal(stripped, "echo       'no $(y)'")
})

test("extractSubstitutions leaves an unterminated span in place", () => {
  assert.deepEqual(extractSubstitutions("echo $(oops"), { inner: [], stripped: "echo $(oops" })
  assert.deepEqual(extractSubstitutions("echo `oops"), { inner: [], stripped: "echo `oops" })
})
