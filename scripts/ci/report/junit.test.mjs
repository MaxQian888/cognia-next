/**
 * Coverage for scripts/ci/report/junit.mjs.
 *
 * The fixtures below are shaped exactly like jest-junit's real output
 * (attribute order, `classname`, self-closing passes, `<failure message=…>`),
 * because a parser tested only against tidy hand-written XML is a parser
 * tested against the wrong thing.
 *
 * Run with: node --test scripts/ci/report/junit.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { decodeXml, parseAttributes, parseJUnit, summarizeJUnit } from "./junit.mjs"

const SHARD_1 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="4" failures="1" time="9.5">
  <testsuite name="lib/goal/engine" tests="3" failures="1" time="7.25">
    <testcase classname="lib/goal/engine.test.ts" name="resolves a goal" time="5"/>
    <testcase classname="lib/goal/engine.test.ts" name="rejects an empty goal" time="2">
      <failure message="expected 1 to equal 2">at Object.&lt;anonymous&gt; (engine.test.ts:12:3)</failure>
    </testcase>
    <testcase classname="lib/goal/engine.test.ts" name="handles retries" time="0.25">
      <skipped/>
    </testcase>
  </testsuite>
  <testsuite name="lib/fast" tests="1" failures="0" time="0.1">
    <testcase classname="lib/fast.test.ts" name="is fast" time="0.1"/>
  </testsuite>
</testsuites>`

const SHARD_2 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="1" failures="0" time="12">
  <testsuite name="components/slow" tests="1" failures="0" time="12">
    <testcase classname="components/slow.test.tsx" name="renders" time="12"/>
  </testsuite>
</testsuites>`

test("decodeXml handles the predefined entities and numeric escapes", () => {
  assert.equal(decodeXml("a &lt;b&gt; &quot;c&quot; &apos;d&apos; &amp; e"), `a <b> "c" 'd' & e`)
  assert.equal(decodeXml("&#65;&#x42;"), "AB")
  // &amp; is decoded last so an encoded entity survives one round trip.
  assert.equal(decodeXml("&amp;lt;"), "&lt;")
})

test("parseAttributes reads quoted attributes and decodes their values", () => {
  assert.deepEqual(parseAttributes(' name="a b" time="1.5" classname="x/y.test.ts"'), {
    name: "a b",
    time: "1.5",
    classname: "x/y.test.ts",
  })
  assert.deepEqual(parseAttributes(' message="1 &lt; 2"'), { message: "1 < 2" })
  assert.deepEqual(parseAttributes(""), {})
})

test("parseJUnit classifies passed, failed and skipped cases", () => {
  const { cases } = parseJUnit(SHARD_1)
  assert.equal(cases.length, 4)

  assert.deepEqual(
    cases.map((c) => c.status),
    ["passed", "failed", "skipped", "passed"]
  )
  assert.equal(cases[0].name, "resolves a goal")
  assert.equal(cases[0].time, 5)
  assert.equal(cases[0].suite, "lib/goal/engine.test.ts")
})

test("parseJUnit prefers the failure's message attribute over its body", () => {
  const { cases } = parseJUnit(SHARD_1)
  assert.equal(cases[1].message, "expected 1 to equal 2")
})

test("parseJUnit falls back to the failure body when there is no message attribute", () => {
  const xml = `<testsuite><testcase classname="a" name="b" time="1">
    <failure>boom &amp; crash</failure>
  </testcase></testsuite>`
  const { cases } = parseJUnit(xml)
  assert.equal(cases[0].status, "failed")
  assert.equal(cases[0].message, "boom & crash")
})

test("parseJUnit treats <error> like <failure>", () => {
  const xml = `<testsuite><testcase classname="a" name="b" time="1">
    <error message="suite failed to run"/>
  </testcase></testsuite>`
  const { cases } = parseJUnit(xml)
  assert.equal(cases[0].status, "failed")
  assert.equal(cases[0].message, "suite failed to run")
})

test("parseJUnit does not leak one testcase's failure into the next", () => {
  const xml = `<testsuite>
    <testcase classname="a" name="fails" time="1"><failure message="x"/></testcase>
    <testcase classname="a" name="passes" time="1"/>
  </testsuite>`
  const { cases } = parseJUnit(xml)
  assert.deepEqual(
    cases.map((c) => c.status),
    ["failed", "passed"]
  )
})

test("parseJUnit returns nothing for an empty or case-free document", () => {
  assert.deepEqual(parseJUnit("").cases, [])
  assert.deepEqual(parseJUnit("<testsuites/>").cases, [])
})

test("summarizeJUnit folds every shard into one tally", () => {
  const summary = summarizeJUnit([SHARD_1, SHARD_2])
  assert.equal(summary.total, 5)
  assert.equal(summary.passed, 3)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.failed.length, 1)
  assert.equal(summary.failed[0].name, "rejects an empty goal")
  // Grouped by `classname` (the file), not by <testsuite> element: the three
  // engine cases share one classname.
  assert.equal(summary.suites, 3)
  assert.equal(summary.totalTime, 19.35)
})

test("summarizeJUnit ranks the slowest suites across shards", () => {
  const summary = summarizeJUnit([SHARD_1, SHARD_2], { slowest: 2 })
  assert.deepEqual(
    summary.slowest.map((s) => s.suite),
    ["components/slow.test.tsx", "lib/goal/engine.test.ts"]
  )
  assert.equal(summary.slowest[0].time, 12)
  assert.equal(summary.slowest[1].time, 7.25)
  assert.equal(summary.slowest[1].tests, 3)
})

test("summarizeJUnit copes with zero shards", () => {
  const summary = summarizeJUnit([])
  assert.equal(summary.total, 0)
  assert.deepEqual(summary.failed, [])
  assert.deepEqual(summary.slowest, [])
})
