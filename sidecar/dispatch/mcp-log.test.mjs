// Tests for the pure MCP-log capture/classification helpers. No I/O — exercises
// the line buffering, level inference, server-name extraction, event shaping,
// and the stderr sink that turns a chunked stream into `mcp_log` events.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createLineBuffer,
  inferLevel,
  extractServerName,
  classifyMcpLogLine,
  buildMcpLogEvent,
  createStderrLogSink,
  MCP_LOG_LEVELS,
} from "./mcp-log.mjs"

test("createLineBuffer yields complete lines and holds the partial tail", () => {
  const buf = createLineBuffer()
  assert.deepEqual(buf.push("hello\nwor"), ["hello"])
  assert.deepEqual(buf.push("ld\nnext\n"), ["world", "next"])
  assert.deepEqual(buf.push("trailing"), [])
  assert.deepEqual(buf.flush(), ["trailing"])
  // Flush is idempotent-empty afterwards.
  assert.deepEqual(buf.flush(), [])
})

test("createLineBuffer normalises CRLF and drops blank lines", () => {
  const buf = createLineBuffer()
  assert.deepEqual(buf.push("a\r\n\r\nb\r\n"), ["a", "b"])
})

test("inferLevel recognises common conventions and defaults to info", () => {
  assert.equal(inferLevel("[ERROR] boom"), "error")
  assert.equal(inferLevel("connection failed: ECONNREFUSED"), "info") // no level token
  assert.equal(inferLevel("fatal: cannot spawn"), "error")
  assert.equal(inferLevel("warn: retrying"), "warn")
  assert.equal(inferLevel("[warning] slow"), "warn")
  assert.equal(inferLevel("debug: handshake"), "debug")
  assert.equal(inferLevel("[info] ready"), "info")
  assert.equal(inferLevel("just some text"), "info")
})

test("inferLevel does not match a level word embedded in another token", () => {
  assert.equal(inferLevel("loaded errorHandler.ts module"), "info")
})

test("extractServerName handles the common self-identifying shapes", () => {
  assert.equal(extractServerName("[MCP][github] connected"), "github")
  assert.equal(extractServerName('MCP server "filesystem" started'), "filesystem")
  assert.equal(extractServerName("[playwright] launching"), "playwright")
  assert.equal(extractServerName("calling mcp__context7__query-docs"), "context7")
  assert.equal(extractServerName("no server here"), undefined)
  // A bracketed level word is not mistaken for a server name.
  assert.equal(extractServerName("[error] something"), undefined)
})

test("extractServerName ignores EVERY level word inferLevel recognizes", () => {
  // These would otherwise spawn phantom `[FATAL]` / `[verbose]` servers in the
  // panel and mis-attribute the line — the skip-list must cover inferLevel's
  // full vocabulary, not just error/warn/info/debug.
  for (const level of ["fatal", "panic", "err", "verbose", "notice", "log", "warning", "trace"]) {
    assert.equal(
      extractServerName(`[${level}] connection lost`),
      undefined,
      `level word "${level}" leaked as a server name`
    )
    assert.equal(extractServerName(`[${level.toUpperCase()}] connection lost`), undefined)
  }
})

test("classifyMcpLogLine falls back to knownServer and strips trailing ws", () => {
  const r = classifyMcpLogLine("plain diagnostic line   ", { knownServer: "github" })
  assert.deepEqual(r, { level: "info", server: "github", message: "plain diagnostic line" })
  // Embedded server name wins over knownServer.
  const r2 = classifyMcpLogLine("[filesystem] warn: x", { knownServer: "github" })
  assert.equal(r2.server, "filesystem")
  assert.equal(r2.level, "warn")
})

test("buildMcpLogEvent shapes an event and omits absent server", () => {
  assert.deepEqual(
    buildMcpLogEvent({ sessionId: "s1", ts: 5, level: "error", message: "boom", source: "stderr" }),
    { type: "mcp_log", sessionId: "s1", ts: 5, level: "error", message: "boom", source: "stderr" }
  )
  const withServer = buildMcpLogEvent({
    sessionId: "s1",
    ts: 5,
    level: "warn",
    message: "x",
    server: "github",
    source: "diagnostic",
  })
  assert.equal(withServer.server, "github")
  assert.equal(withServer.source, "diagnostic")
})

test("buildMcpLogEvent defaults source to stderr", () => {
  const e = buildMcpLogEvent({ sessionId: "s", ts: 1, level: "info", message: "m" })
  assert.equal(e.source, "stderr")
})

test("createStderrLogSink emits one mcp_log per line with injected clock", () => {
  const events = []
  let clock = 100
  const sink = createStderrLogSink({
    sessionId: "s1",
    emit: (e) => events.push(e),
    now: () => clock++,
    knownServer: "github",
    source: "stderr",
  })
  sink.write("[error] boom\nwarn: slow\n")
  sink.write("partial")
  sink.end()
  assert.equal(events.length, 3)
  assert.deepEqual(
    events.map((e) => [e.level, e.message, e.server, e.ts]),
    [
      ["error", "[error] boom", "github", 100],
      ["warn", "warn: slow", "github", 101],
      ["info", "partial", "github", 102],
    ]
  )
  assert.ok(events.every((e) => e.type === "mcp_log" && e.sessionId === "s1"))
})

test("createStderrLogSink swallows emit failures (never faults the producer)", () => {
  const sink = createStderrLogSink({
    sessionId: "s1",
    emit: () => {
      throw new Error("downstream dead")
    },
  })
  assert.doesNotThrow(() => {
    sink.write("line one\n")
    sink.end()
  })
})

test("MCP_LOG_LEVELS is severity-ordered", () => {
  assert.deepEqual(MCP_LOG_LEVELS, ["error", "warn", "info", "debug"])
})
