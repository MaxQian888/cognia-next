import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  LocalConfigError,
  errorLine,
  parseConfigLine,
  parseLocalConfig,
  readConfigLine,
  readyLine,
  watchParentStdin,
} from "./local-config.mjs"

const valid = {
  secret: "s".repeat(32),
  profilesRoot: "/data/browser/profiles",
  overlayPath: "/app/overlay.injected.js",
}

test("parses a valid config with defaults and a derived staging root", () => {
  assert.deepEqual(parseLocalConfig(valid), {
    secret: "s".repeat(32),
    profilesRoot: "/data/browser/profiles",
    stagingRoot: "/data/browser/.download-staging",
    overlayPath: "/app/overlay.injected.js",
    browsersPath: undefined,
    maxSessions: 4,
    maxPages: 32,
  })
  const custom = parseLocalConfig({
    ...valid,
    browsersPath: "/data/browser/chromium",
    maxSessions: 2,
    maxPages: 10,
  })
  assert.equal(custom.browsersPath, "/data/browser/chromium")
  assert.equal(custom.maxSessions, 2)
  assert.equal(custom.maxPages, 10)
})

test("rejects short secrets, relative paths and bad limits", () => {
  for (const bad of [
    null,
    [],
    "text",
    { ...valid, secret: "short" },
    { ...valid, secret: 42 },
    { ...valid, profilesRoot: "relative/profiles" },
    { ...valid, overlayPath: undefined },
    { ...valid, browsersPath: "chromium" },
    { ...valid, maxSessions: 0 },
    { ...valid, maxPages: 1.5 },
    { ...valid, maxSessions: 1000 },
  ]) {
    assert.throws(
      () => parseLocalConfig(bad),
      (error) => error instanceof LocalConfigError && error.code === "config_invalid"
    )
  }
  assert.throws(
    () => parseConfigLine("{not json"),
    (error) => error.code === "config_invalid"
  )
})

test("reads exactly the first stdin line, split across chunks", async () => {
  const stream = new PassThrough()
  const pending = readConfigLine(stream)
  stream.write('{"a":')
  stream.write('1}\r\n{"ignored":true}\n')
  assert.equal(await pending, '{"a":1}')
})

test("rejects when stdin ends before a newline or the line is too large", async () => {
  const ended = new PassThrough()
  const missing = readConfigLine(ended)
  ended.end('{"partial":')
  await assert.rejects(missing, (error) => error.code === "config_missing")

  const huge = new PassThrough()
  const tooLarge = readConfigLine(huge, { maxBytes: 8 })
  huge.write("0123456789")
  await assert.rejects(tooLarge, (error) => error.code === "config_too_large")
})

test("formats the ready and error protocol lines", () => {
  assert.equal(
    readyLine({ address: "127.0.0.1", family: "IPv4", port: 5000 }),
    '{"type":"ready","mode":"local","address":{"address":"127.0.0.1","family":"IPv4","port":5000}}\n'
  )
  assert.equal(
    errorLine(new LocalConfigError("config_invalid", "bad")),
    '{"type":"error","code":"config_invalid","message":"bad"}\n'
  )
  assert.equal(
    errorLine(new Error("boom")),
    '{"type":"error","code":"startup_failed","message":"boom"}\n'
  )
})

test("watchParentStdin fires once when the parent's stdin ends", async () => {
  const stream = new PassThrough()
  let calls = 0
  watchParentStdin(stream, () => {
    calls += 1
  })
  stream.write("noise\n")
  stream.end()
  await new Promise((resolve) => setImmediate(resolve))
  stream.emit("close")
  assert.equal(calls, 1)
})

test("watchParentStdin fires when stdin had already ended before it was attached", async () => {
  const stream = new PassThrough()
  stream.resume()
  stream.end()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stream.readableEnded, true)
  let calls = 0
  watchParentStdin(stream, () => {
    calls += 1
  })
  await new Promise((resolve) => setImmediate(resolve))
  stream.emit("close")
  assert.equal(calls, 1)
})
