import { test } from "node:test"
import assert from "node:assert/strict"
import {
  makeServerAlwaysLoad,
  alwaysLoadToolSet,
  stampUserServersAlwaysLoad,
} from "./tool-search-policy.mjs"

test("tool search OFF (default) → every server stays always-load", () => {
  const pred = makeServerAlwaysLoad({})
  assert.equal(pred("cognia-tools"), true)
  assert.equal(pred("anything"), true)
})

test("tool search OFF ignores alwaysLoadServers (everything resident anyway)", () => {
  const pred = makeServerAlwaysLoad({ alwaysLoadServers: ["x"] })
  assert.equal(pred("x"), true)
  assert.equal(pred("y"), true)
})

test("tool search ON → only listed servers stay always-load, rest defer", () => {
  const pred = makeServerAlwaysLoad({
    toolSearchEnabled: true,
    alwaysLoadServers: ["cognia-tools", "a2ui-bridge"],
  })
  assert.equal(pred("cognia-tools"), true)
  assert.equal(pred("a2ui-bridge"), true)
  assert.equal(pred("some-mcp"), false)
})

test("tool search ON with empty list → everything defers", () => {
  const pred = makeServerAlwaysLoad({ toolSearchEnabled: true })
  assert.equal(pred("cognia-tools"), false)
  assert.equal(pred("x"), false)
})

test("alwaysLoadToolSet returns the configured names as a Set", () => {
  assert.deepEqual([...alwaysLoadToolSet({ alwaysLoadTools: ["a", "b"] })], ["a", "b"])
  assert.equal(alwaysLoadToolSet({}).size, 0)
  assert.equal(alwaysLoadToolSet({ alwaysLoadTools: "nope" }).size, 0)
})

test("stampUserServersAlwaysLoad stamps only servers the predicate keeps resident", () => {
  const servers = {
    keep: { type: "stdio", command: "x" },
    defer: { type: "http", url: "u" },
  }
  const pred = (name) => name === "keep"
  const out = stampUserServersAlwaysLoad(servers, pred)
  assert.deepEqual(out.keep, { type: "stdio", command: "x", alwaysLoad: true })
  assert.deepEqual(out.defer, { type: "http", url: "u" })
  // Input is not mutated.
  assert.equal("alwaysLoad" in servers.keep, false)
})

test("stampUserServersAlwaysLoad passes through non-object configs untouched", () => {
  const out = stampUserServersAlwaysLoad({ a: null, b: "str" }, () => true)
  assert.equal(out.a, null)
  assert.equal(out.b, "str")
})

test("stampUserServersAlwaysLoad handles undefined/empty maps", () => {
  assert.deepEqual(
    stampUserServersAlwaysLoad(undefined, () => true),
    {}
  )
  assert.deepEqual(
    stampUserServersAlwaysLoad({}, () => true),
    {}
  )
})

test("end-to-end: OFF policy stamps every user server resident", () => {
  const sendOptions = { mcpServers: { a: { type: "stdio" }, b: { type: "http" } } }
  const pred = makeServerAlwaysLoad(sendOptions)
  const out = stampUserServersAlwaysLoad(sendOptions.mcpServers, pred)
  assert.equal(out.a.alwaysLoad, true)
  assert.equal(out.b.alwaysLoad, true)
})

test("end-to-end: ON policy stamps only the allowlisted user server", () => {
  const sendOptions = {
    toolSearchEnabled: true,
    alwaysLoadServers: ["a"],
    mcpServers: { a: { type: "stdio" }, b: { type: "http" } },
  }
  const pred = makeServerAlwaysLoad(sendOptions)
  const out = stampUserServersAlwaysLoad(sendOptions.mcpServers, pred)
  assert.equal(out.a.alwaysLoad, true)
  assert.equal("alwaysLoad" in out.b, false)
})
