import test from "node:test"
import assert from "node:assert/strict"

import { STATUS, createRunReport, isFailing, summarize, writeRunReport } from "./report.mjs"
import { diagnoseTurn } from "./diagnose.mjs"
import { buildMarker } from "./marker.mjs"
import { createRedactor } from "./redact.mjs"

const MARKER = buildMarker("slack", "abcd", 1)
const HIT = { model: "claude-opus-5", stream: true, messageCount: 3, markers: [MARKER] }

function clock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test("phases record their own duration and outcome", () => {
  const c = clock()
  const report = createRunReport({ platform: "slack", runId: "abcd", now: c.now })
  const end = report.phase("doctor")
  c.advance(250)
  end()
  const endFailed = report.phase("turn-1")
  c.advance(50)
  endFailed("timeout")
  assert.deepEqual(report.toJSON().phases, [
    { name: "doctor", ms: 250, outcome: "ok" },
    { name: "turn-1", ms: 50, outcome: "timeout" },
  ])
})

test("a recorded turn keeps ids and marker facts but never message text", () => {
  const report = createRunReport({ platform: "slack", runId: "abcd" })
  const replies = [
    {
      messageId: "1700.0001",
      at: 1700,
      threadId: "1699.0001",
      text: `echo ${MARKER} plus PRIVATE-BODY`,
    },
  ]
  report.recordTurn({
    turn: 1,
    marker: MARKER,
    probe: { messageId: "1699.0001", sentAt: 1699 },
    fixtureHit: HIT,
    replies,
    diagnosis: diagnoseTurn({ fixtureHit: HIT, replies, marker: MARKER }),
  })
  const json = report.toJSON()
  const serialized = JSON.stringify(json)
  assert.ok(!serialized.includes("PRIVATE-BODY"), "reply text must never reach the report")
  assert.equal(json.turns[0].replies[0].messageId, "1700.0001")
  assert.equal(json.turns[0].replies[0].threadId, "1699.0001")
  assert.equal(json.turns[0].replies[0].matchedMarker, true)
  assert.equal(json.turns[0].probeMessageId, "1699.0001")
  assert.equal(json.turns[0].fixture.hit, true)
  assert.equal(json.turns[0].status, STATUS.PASS)
})

test("a missed fixture is recorded as hit:false rather than omitted", () => {
  const report = createRunReport({ platform: "slack", runId: "abcd" })
  report.recordTurn({
    turn: 1,
    marker: MARKER,
    probe: { messageId: "p" },
    fixtureHit: null,
    replies: [],
    diagnosis: diagnoseTurn({ fixtureHit: null, replies: [], marker: MARKER }),
  })
  assert.deepEqual(report.toJSON().turns[0].fixture, { hit: false })
})

test("the lock and its theft are part of the evidence", () => {
  const report = createRunReport({ platform: "lark", runId: "ff" })
  report.recordLock({ file: "test-results/im-live/.locks/lark-x.lock", stoleFrom: 4242 })
  assert.deepEqual(report.toJSON().lock, {
    file: "test-results/im-live/.locks/lark-x.lock",
    stoleFrom: 4242,
  })
})

test("finish stamps the status and the total duration", () => {
  const c = clock()
  const report = createRunReport({ platform: "matrix", runId: "aa", now: c.now })
  c.advance(9000)
  const json = report.finish(STATUS.PASS)
  assert.equal(json.status, STATUS.PASS)
  assert.equal(json.durationMs, 9000)
  assert.equal(json.schema, "cognia.im-live.run/1")
})

test("an unfinished report defaults to FAIL rather than looking clean", () => {
  assert.equal(createRunReport({ platform: "matrix", runId: "aa" }).toJSON().status, STATUS.FAIL)
})

test("writeRunReport lands under <outputDir>/<runId>/<platform>.json and is redacted", async () => {
  const written = []
  const redactor = createRedactor()
  redactor.register("super-secret-bot-token", "driverBotToken")
  const report = createRunReport({ platform: "discord", runId: "d00d" })
  report.finish(STATUS.FAIL, "auth failed for super-secret-bot-token")

  const file = await writeRunReport({
    outputDir: "test-results/im-live",
    report,
    redactor,
    fs: {
      mkdir: async () => {},
      writeFile: async (target, body) => written.push({ target, body }),
    },
  })
  assert.equal(file, "test-results/im-live/d00d/discord.json")
  assert.equal(written[0].target, file)
  assert.ok(!written[0].body.includes("super-secret-bot-token"))
  assert.ok(written[0].body.includes("«driverBotToken»"))
  assert.ok(written[0].body.endsWith("\n"))
})

test("isFailing separates real failures from an absent platform", () => {
  assert.equal(isFailing(STATUS.PASS), false)
  assert.equal(isFailing(STATUS.NOT_CONFIGURED), false)
  assert.equal(isFailing(STATUS.MODEL_NOT_INTERCEPTED), true)
  assert.equal(isFailing(STATUS.TIMEOUT), true)
})

test("summarize counts statuses and picks the exit code", () => {
  assert.deepEqual(summarize([{ status: STATUS.PASS }, { status: STATUS.PASS }]), {
    counts: { PASS: 2 },
    line: "2 PASS",
    exitCode: 0,
  })
  const mixed = summarize([
    { status: STATUS.PASS },
    { status: STATUS.NOT_CONFIGURED },
    { status: STATUS.MODEL_NOT_INTERCEPTED },
  ])
  assert.equal(mixed.exitCode, 1)
  assert.equal(mixed.line, "1 PASS, 1 MODEL_NOT_INTERCEPTED, 1 NOT_CONFIGURED")
})

test("an all-NOT_CONFIGURED run exits zero — nothing was proven, nothing broke", () => {
  assert.equal(summarize([{ status: STATUS.NOT_CONFIGURED }]).exitCode, 0)
  assert.equal(summarize([]).line, "nothing ran")
})
