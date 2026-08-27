import test from "node:test"
import assert from "node:assert/strict"

import { FAILING_STATUSES, STATUS, diagnoseTurn, formatDiagnosis } from "./diagnose.mjs"
import { buildMarker } from "./marker.mjs"

const MARKER = buildMarker("telegram", "cafe", 1)
const HIT = { model: "claude-opus-5", stream: true, messageCount: 1, markers: [MARKER] }

const reply = (text) => ({ messageId: "m1", text })

test("fixture hit + exactly one marked reply is a pass with no causes", () => {
  const d = diagnoseTurn({ fixtureHit: HIT, replies: [reply(`echo ${MARKER}`)], marker: MARKER })
  assert.equal(d.status, STATUS.PASS)
  assert.deepEqual(d.causes, [])
  assert.equal(d.markerReplyCount, 1)
})

test("no fixture hit and no reply is a TIMEOUT naming the inbound gates", () => {
  const d = diagnoseTurn({ fixtureHit: null, replies: [], marker: MARKER })
  assert.equal(d.status, STATUS.TIMEOUT)
  const codes = d.causes.map((c) => c.code)
  assert.ok(codes.includes("sibling_identity_unknown"))
  assert.ok(codes.includes("at_mention_required"))
  assert.ok(codes.includes("pii_blocked"))
  assert.ok(codes.includes("transport_not_connected"))
})

test("a reply WITHOUT a fixture hit means a real model answered", () => {
  const d = diagnoseTurn({
    fixtureHit: null,
    replies: [reply("sure, happy to help!")],
    marker: MARKER,
  })
  assert.equal(d.status, STATUS.MODEL_NOT_INTERCEPTED)
  assert.match(d.summary, /REAL model/)
  const codes = d.causes.map((c) => c.code)
  assert.ok(codes.includes("vault_provider_overrides_base_url"))
  assert.ok(codes.includes("frozen_execution_spec_rebuilds_env"))
})

test("a marked reply without a fixture hit is still MODEL_NOT_INTERCEPTED", () => {
  // The real model would echo the marker too if the prompt asked it to; the
  // fixture log, not the reply text, is what proves interception.
  const d = diagnoseTurn({ fixtureHit: null, replies: [reply(`sure — ${MARKER}`)], marker: MARKER })
  assert.equal(d.status, STATUS.MODEL_NOT_INTERCEPTED)
})

test("fixture hit but no reply blames outbound, not inbound", () => {
  const d = diagnoseTurn({ fixtureHit: HIT, replies: [], marker: MARKER })
  assert.equal(d.status, STATUS.FAIL)
  assert.match(d.summary, /outbound failed/)
  assert.deepEqual(
    d.causes.map((c) => c.code),
    ["outbound_deadlettered", "outbound_permission", "outbound_rate_limited"]
  )
})

test("a reply carrying someone else's marker fails as a mismatch", () => {
  const other = buildMarker("telegram", "beef", 1)
  const d = diagnoseTurn({ fixtureHit: HIT, replies: [reply(`echo ${other}`)], marker: MARKER })
  assert.equal(d.status, STATUS.FAIL)
  assert.equal(d.markerReplyCount, 0)
  assert.equal(d.extraReplyCount, 1)
  assert.deepEqual(
    d.causes.map((c) => c.code),
    ["reply_marker_mismatch"]
  )
})

test("two marked replies is a duplicate-consumption failure", () => {
  const d = diagnoseTurn({
    fixtureHit: HIT,
    replies: [reply(`a ${MARKER}`), reply(`b ${MARKER}`)],
    marker: MARKER,
  })
  assert.equal(d.status, STATUS.FAIL)
  assert.equal(d.markerReplyCount, 2)
  assert.deepEqual(
    d.causes.map((c) => c.code),
    ["duplicate_consumption", "bot_interplay_loop"]
  )
})

test("one marked reply alongside an unrelated one still passes, and counts the extra", () => {
  const d = diagnoseTurn({
    fixtureHit: HIT,
    replies: [reply(`mine ${MARKER}`), reply("answering someone else")],
    marker: MARKER,
  })
  assert.equal(d.status, STATUS.PASS)
  assert.equal(d.extraReplyCount, 1)
})

test("replies with no text never crash the classifier", () => {
  const d = diagnoseTurn({ fixtureHit: HIT, replies: [{ messageId: "m" }], marker: MARKER })
  assert.equal(d.status, STATUS.FAIL)
})

test("every failing status is in FAILING_STATUSES, and PASS is not", () => {
  assert.ok(!FAILING_STATUSES.includes(STATUS.PASS))
  assert.ok(!FAILING_STATUSES.includes(STATUS.NOT_CONFIGURED))
  for (const s of [
    STATUS.FAIL,
    STATUS.TIMEOUT,
    STATUS.MODEL_NOT_INTERCEPTED,
    STATUS.DOCTOR_FAILED,
  ]) {
    assert.ok(FAILING_STATUSES.includes(s), s)
  }
})

test("formatDiagnosis prints each cause with where to look", () => {
  const text = formatDiagnosis(diagnoseTurn({ fixtureHit: null, replies: [], marker: MARKER }))
  assert.match(text, /^TIMEOUT: /)
  assert.match(text, /\[sibling_identity_unknown\]/)
  assert.match(text, /→ lib\/connectors\/bus\.ts step 9\.6/)
})

test("formatDiagnosis stays short when there is nothing to diagnose", () => {
  const text = formatDiagnosis(
    diagnoseTurn({ fixtureHit: HIT, replies: [reply(MARKER)], marker: MARKER })
  )
  assert.equal(text.split("\n").length, 1)
})
