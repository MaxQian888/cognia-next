import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  toolBudgetMessage,
  wrapHandlerWithReadOnlyTimeout,
  wrapDefsWithReadOnlyTimeout,
} from "../read-only-timeout.mjs"

const READ_ONLY = new Set(["grep", "read"])

test("DEFAULT_BUILTIN_TOOL_TIMEOUT_MS is 120s", () => {
  assert.equal(DEFAULT_BUILTIN_TOOL_TIMEOUT_MS, 120_000)
})

test("toolBudgetMessage names the tool and its budget", () => {
  const msg = toolBudgetMessage("grep", 20)
  assert.match(msg, /grep.*execution budget/)
  assert.match(msg, /20ms/)
})

test("a hung read-only tool resolves to an isError result after the budget", async () => {
  const def = {
    name: "grep",
    handler: () => new Promise(() => {}), // never settles
  }
  const wrapped = wrapHandlerWithReadOnlyTimeout(def, 20, READ_ONLY)
  const res = await wrapped.handler({}, {})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /grep.*execution budget/)
})

test("a read-only tool that finishes in time passes its result through", async () => {
  const def = { name: "read", handler: async () => ({ content: [{ type: "text", text: "ok" }] }) }
  const wrapped = wrapHandlerWithReadOnlyTimeout(def, 1000, READ_ONLY)
  const res = await wrapped.handler({}, {})
  assert.equal(res.content[0].text, "ok")
  assert.equal(res.isError, undefined)
})

test("a read-only handler that rejects before the deadline rethrows its own error", async () => {
  const def = {
    name: "grep",
    handler: async () => {
      throw new Error("boom from handler")
    },
  }
  const wrapped = wrapHandlerWithReadOnlyTimeout(def, 1000, READ_ONLY)
  await assert.rejects(wrapped.handler({}, {}), /boom from handler/)
})

test("exec / non-read-only tools are NEVER bounded (returned untouched)", () => {
  const def = { name: "bash", handler: () => new Promise(() => {}) }
  const wrapped = wrapHandlerWithReadOnlyTimeout(def, 20, READ_ONLY)
  assert.equal(wrapped, def) // same reference — no wrapping
})

test("a 0 / non-finite budget disables the net (def returned untouched)", () => {
  const def = { name: "grep", handler: () => new Promise(() => {}) }
  assert.equal(wrapHandlerWithReadOnlyTimeout(def, 0, READ_ONLY), def)
  assert.equal(wrapHandlerWithReadOnlyTimeout(def, Number.POSITIVE_INFINITY, READ_ONLY), def)
  assert.equal(wrapHandlerWithReadOnlyTimeout(def, NaN, READ_ONLY), def)
})

test("wrapDefsWithReadOnlyTimeout returns the same array when disabled, wraps when enabled", async () => {
  const defs = [
    { name: "grep", handler: () => new Promise(() => {}) },
    { name: "bash", handler: () => new Promise(() => {}) },
  ]
  // Disabled → identical reference (no allocation).
  assert.equal(wrapDefsWithReadOnlyTimeout(defs, 0, READ_ONLY), defs)
  // Enabled → new array; read-only def wrapped, exec def untouched.
  const guarded = wrapDefsWithReadOnlyTimeout(defs, 20, READ_ONLY)
  assert.notEqual(guarded, defs)
  assert.notEqual(guarded[0], defs[0]) // grep wrapped
  assert.equal(guarded[1], defs[1]) // bash untouched
  const res = await guarded[0].handler({}, {})
  assert.equal(res.isError, true)
})
