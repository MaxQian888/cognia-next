import test from "node:test"
import assert from "node:assert/strict"

import {
  MARKER_RE,
  buildMarker,
  containsMarker,
  findMarkers,
  markersForRun,
  newRunId,
} from "./marker.mjs"

test("newRunId is unpredictable and regex-compatible", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()))
  assert.equal(ids.size, 200, "200 ids must all differ")
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/)
})

test("buildMarker produces a string the shared regex matches", () => {
  const marker = buildMarker("telegram", "0123456789abcdef", 1)
  assert.equal(marker, "cognia-e2e:telegram:0123456789abcdef:turn-1")
  assert.deepEqual(findMarkers(marker), [marker])
})

test("buildMarker rejects input that would silently never match", () => {
  assert.throws(() => buildMarker("Telegram", "abc", 1), /platform/)
  assert.throws(() => buildMarker("tele gram", "abc", 1), /platform/)
  assert.throws(() => buildMarker("telegram", "ZZZ", 1), /runId/)
  assert.throws(() => buildMarker("telegram", "abc", 0), /turn/)
  assert.throws(() => buildMarker("telegram", "abc", 1.5), /turn/)
})

test("findMarkers de-duplicates and survives repeated calls on the global regex", () => {
  const a = buildMarker("slack", "aa11", 1)
  const b = buildMarker("slack", "aa11", 2)
  const text = `noise ${a} more ${a} then ${b} end`
  // Called twice: a leaked `lastIndex` would make the second call miss.
  assert.deepEqual(findMarkers(text), [a, b])
  assert.deepEqual(findMarkers(text), [a, b])
})

test("findMarkers tolerates non-strings and empty input", () => {
  assert.deepEqual(findMarkers(undefined), [])
  assert.deepEqual(findMarkers(null), [])
  assert.deepEqual(findMarkers(""), [])
  assert.deepEqual(findMarkers(42), [])
})

test("containsMarker matches a marker embedded in surrounding text", () => {
  const marker = buildMarker("discord", "beef", 1)
  assert.ok(containsMarker(`[mock-anthropic-echo] hey ${marker} bye`, marker))
  assert.ok(!containsMarker("no marker here", marker))
  assert.ok(!containsMarker(marker, ""))
  assert.ok(!containsMarker(undefined, marker))
})

test("markersForRun ignores a concurrent run's markers", () => {
  const mine = buildMarker("lark", "1111", 1)
  const theirs = buildMarker("lark", "2222", 1)
  assert.deepEqual(markersForRun(`${mine} ${theirs}`, "1111"), [mine])
})

test("MARKER_RE stays in sync with the fixture's copy", async () => {
  const { readFile } = await import("node:fs/promises")
  const fixture = await readFile("tests/e2e/mocks/anthropic/server.ts", "utf8")
  const match = fixture.match(/const LIVE_MARKER_RE = (\/.+\/g)\n/)
  assert.ok(match, "fixture must declare LIVE_MARKER_RE")
  assert.equal(match[1], MARKER_RE.toString(), "runner and fixture regexes must be identical")
})
