import test from "node:test"
import assert from "node:assert/strict"

import { STATUS } from "./diagnose.mjs"
import { createLease, observedReply } from "./drivers/observe.mjs"
import { buildMarker } from "./marker.mjs"
import { createRunReport } from "./report.mjs"
import { runPlatform, runTurn } from "./run.mjs"

const RUN_ID = "abcd1234"
const M1 = buildMarker("telegram", RUN_ID, 1)
const M2 = buildMarker("telegram", RUN_ID, 2)
const noSleep = async () => {}

/** A fixture whose log is driven by the scripted driver below. */
function fakeFixture({ hitFor = new Set() } = {}) {
  return {
    resets: 0,
    async reset() {
      this.resets++
    },
    async waitForMarker(marker) {
      return hitFor.has(marker) ? { model: "claude-opus-5", stream: true, markers: [marker] } : null
    },
  }
}

/**
 * A driver whose behaviour is a table: which markers get answered, with what,
 * and how many times.
 */
function fakeDriver({
  answers = {},
  doctorChecks = [{ name: "ok", ok: true, detail: "" }],
  cleanupResult,
} = {}) {
  const pending = []
  const calls = { injected: [], replied: [], cleanups: 0, doctor: 0 }
  let counter = 0
  return {
    calls,
    platform: "telegram",
    conversationId: "-100",
    async doctor() {
      calls.doctor++
      return doctorChecks
    },
    async prepare() {
      return createLease({ platform: "telegram", conversationId: "-100" })
    },
    async injectMention(lease, marker) {
      calls.injected.push(marker)
      queue(marker)
      const id = `probe-${++counter}`
      lease.sentMessageIds.push(id)
      return { messageId: id, sentAt: 1 }
    },
    async replyToTarget(lease, target, marker) {
      calls.replied.push({ marker, replyingTo: target?.messageId ?? null })
      queue(marker)
      const id = `probe-${++counter}`
      lease.sentMessageIds.push(id)
      return { messageId: id, sentAt: 2 }
    },
    async pollTargetMessages() {
      return pending.splice(0, pending.length)
    },
    async cleanup() {
      calls.cleanups++
      return cleanupResult ?? { deleted: ["probe-1"], retained: [], ok: true }
    },
  }
  function queue(marker) {
    for (const text of answers[marker] ?? []) {
      pending.push(observedReply({ messageId: `bot-${++counter}`, text, at: 10 }))
    }
  }
}

const turnArgs = (extra) => ({
  turnTimeoutMs: 100,
  duplicateWindowMs: 10,
  now: () => Date.now(),
  sleepImpl: noSleep,
  ...extra,
})

test("a turn passes when the fixture is hit and exactly one marked reply lands", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`] } })
  const lease = await driver.prepare()
  const result = await runTurn(
    turnArgs({
      driver,
      lease,
      fixture: fakeFixture({ hitFor: new Set([M1]) }),
      marker: M1,
      send: () => driver.injectMention(lease, M1),
    })
  )
  assert.equal(result.diagnosis.status, STATUS.PASS)
  assert.equal(result.replies.length, 1)
  assert.ok(result.fixtureHit)
})

test("a turn only counts the replies that arrived during it", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`] } })
  const lease = await driver.prepare()
  lease.observed.push(observedReply({ messageId: "earlier", text: "from a previous turn" }))
  const result = await runTurn(
    turnArgs({
      driver,
      lease,
      fixture: fakeFixture({ hitFor: new Set([M1]) }),
      marker: M1,
      send: () => driver.injectMention(lease, M1),
    })
  )
  assert.equal(result.replies.length, 1, "the earlier turn's reply must not count against this one")
  assert.equal(result.diagnosis.extraReplyCount, 0)
})

test("a reply with no fixture hit is reported as a real model answering", async () => {
  const driver = fakeDriver({ answers: { [M1]: ["Sure! Happy to help."] } })
  const lease = await driver.prepare()
  const result = await runTurn(
    turnArgs({
      driver,
      lease,
      fixture: fakeFixture(),
      marker: M1,
      send: () => driver.injectMention(lease, M1),
    })
  )
  assert.equal(result.diagnosis.status, STATUS.MODEL_NOT_INTERCEPTED)
})

test("silence on both channels is a TIMEOUT", async () => {
  const driver = fakeDriver()
  const lease = await driver.prepare()
  const result = await runTurn(
    turnArgs({
      driver,
      lease,
      fixture: fakeFixture(),
      marker: M1,
      send: () => driver.injectMention(lease, M1),
    })
  )
  assert.equal(result.diagnosis.status, STATUS.TIMEOUT)
})

test("a duplicated answer is caught because the window is always burned", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`, `echo again ${M1}`] } })
  const lease = await driver.prepare()
  const result = await runTurn(
    turnArgs({
      driver,
      lease,
      fixture: fakeFixture({ hitFor: new Set([M1]) }),
      marker: M1,
      send: () => driver.injectMention(lease, M1),
    })
  )
  assert.equal(result.diagnosis.status, STATUS.FAIL)
  assert.equal(result.diagnosis.markerReplyCount, 2)
})

test("a full run does both turns and the second replies to the bot's own message", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`], [M2]: [`echo ${M2}`] } })
  const report = createRunReport({ platform: "telegram", runId: RUN_ID })
  const json = await runPlatform({
    driver,
    fixture: fakeFixture({ hitFor: new Set([M1, M2]) }),
    report,
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 100,
    duplicateWindowMs: 10,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(json.status, STATUS.PASS)
  assert.equal(json.turns.length, 2)
  assert.deepEqual(driver.calls.injected, [M1])
  assert.equal(driver.calls.replied.length, 1)
  assert.equal(driver.calls.replied[0].marker, M2)
  assert.match(
    driver.calls.replied[0].replyingTo,
    /^bot-/,
    "turn 2 must reply to the BOT's message"
  )
})

test("the fixture is reset before the conversation is prepared", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`], [M2]: [`echo ${M2}`] } })
  const fixture = fakeFixture({ hitFor: new Set([M1, M2]) })
  const json = await runPlatform({
    driver,
    fixture,
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 100,
    duplicateWindowMs: 10,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(fixture.resets, 1)
  assert.deepEqual(
    json.phases.map((p) => p.name),
    ["doctor", "fixture-reset", "prepare", "turn-1", "turn-2", "cleanup"]
  )
})

test("a failing turn 1 stops the run and turn 2 is never sent", async () => {
  const driver = fakeDriver()
  const json = await runPlatform({
    driver,
    fixture: fakeFixture(),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 20,
    duplicateWindowMs: 5,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(json.status, STATUS.TIMEOUT)
  assert.equal(json.turns.length, 1)
  assert.equal(driver.calls.replied.length, 0)
})

test("a failing doctor stops before anything is posted", async () => {
  const driver = fakeDriver({
    doctorChecks: [{ name: "driver privacy mode is off", ok: false, detail: "privacy mode is ON" }],
  })
  const json = await runPlatform({
    driver,
    fixture: fakeFixture(),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 20,
    duplicateWindowMs: 5,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(json.status, STATUS.DOCTOR_FAILED)
  assert.match(json.error, /privacy mode is ON/)
  assert.deepEqual(driver.calls.injected, [])
  assert.equal(driver.calls.cleanups, 0, "nothing was posted, so there is nothing to clean up")
})

test("cleanup still runs after a failed turn", async () => {
  const driver = fakeDriver()
  await runPlatform({
    driver,
    fixture: fakeFixture(),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 20,
    duplicateWindowMs: 5,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(driver.calls.cleanups, 1)
})

test("a throwing cleanup is recorded, not allowed to mask the run's verdict", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`], [M2]: [`echo ${M2}`] } })
  driver.cleanup = async () => {
    throw new Error("network down")
  }
  const json = await runPlatform({
    driver,
    fixture: fakeFixture({ hitFor: new Set([M1, M2]) }),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 100,
    duplicateWindowMs: 5,
    cleanup: true,
    sleepImpl: noSleep,
  })
  assert.equal(json.status, STATUS.PASS)
  assert.equal(json.cleanup.ok, false)
  assert.match(json.cleanup.retained[0].reason, /network down/)
})

test("IM_LIVE_KEEP records why nothing was deleted", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`], [M2]: [`echo ${M2}`] } })
  const json = await runPlatform({
    driver,
    fixture: fakeFixture({ hitFor: new Set([M1, M2]) }),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 100,
    duplicateWindowMs: 5,
    cleanup: false,
    sleepImpl: noSleep,
  })
  assert.deepEqual(json.cleanup, { skipped: true, reason: "IM_LIVE_KEEP=1" })
  assert.equal(driver.calls.cleanups, 0)
})

test("runDoctor:false skips the preflight for a caller that already ran it", async () => {
  const driver = fakeDriver({ answers: { [M1]: [`echo ${M1}`], [M2]: [`echo ${M2}`] } })
  await runPlatform({
    driver,
    fixture: fakeFixture({ hitFor: new Set([M1, M2]) }),
    report: createRunReport({ platform: "telegram", runId: RUN_ID }),
    runId: RUN_ID,
    platform: "telegram",
    turnTimeoutMs: 100,
    duplicateWindowMs: 5,
    cleanup: true,
    runDoctor: false,
    sleepImpl: noSleep,
  })
  assert.equal(driver.calls.doctor, 0)
})
