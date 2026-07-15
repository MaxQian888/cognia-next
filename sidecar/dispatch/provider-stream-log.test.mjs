// Co-located test for `createProviderStreamLogger`. The clock is injected so
// elapsed-ms assertions are exact rather than timing-dependent.

import { test } from "node:test"
import assert from "node:assert/strict"

import { createProviderStreamLogger } from "./provider-stream-log.mjs"

/** Fake clock returning each queued reading in turn, then repeating the last. */
function fakeClock(readings) {
  let i = 0
  return () => readings[Math.min(i++, readings.length - 1)]
}

function setup(readings, { turnId } = {}) {
  const logs = []
  const logger = createProviderStreamLogger({
    sessionId: "s1",
    turnId,
    log: (level, message) => logs.push({ level, message }),
    now: fakeClock(readings),
  })
  return { logs, logger }
}

test("logs the time to the FIRST provider event, once", () => {
  // start=1000, first event=1250, second event=1400
  const { logs, logger } = setup([1000, 1250, 1400])
  logger.onEvent()
  logger.onEvent()
  assert.equal(logs.length, 1, "only the first event logs")
  assert.equal(logs[0].level, "info")
  assert.match(logs[0].message, /session s1: first provider event after 250ms/)
})

test("logs stream end with elapsed time and the event count", () => {
  // Only the FIRST onEvent reads the clock, so three readings cover
  // start / first-event / end regardless of how many events stream.
  const { logs, logger } = setup([1000, 1100, 5000])
  logger.onEvent()
  logger.onEvent()
  logger.onEnd()
  assert.match(logs.at(-1).message, /provider stream ended after 4000ms \(2 events\)/)
})

test("a turn that ends without ever streaming reports zero events", () => {
  const { logs, logger } = setup([1000, 3000])
  logger.onEnd()
  assert.equal(logs.length, 1)
  assert.match(logs[0].message, /provider stream ended after 2000ms \(0 events\)/)
})

test("an error BEFORE the first byte is reported as 'never arrived'", () => {
  // This is the shape of the un-diagnosable stall: nothing ever streamed.
  const { logs, logger } = setup([1000, 900_000])
  logger.onError(new Error("socket hang up"))
  assert.equal(logs[0].level, "error")
  assert.match(logs[0].message, /provider stream failed after 899000ms/)
  assert.match(logs[0].message, /0 events, first event never arrived/)
  assert.match(logs[0].message, /socket hang up/)
})

test("an error AFTER streaming started reports when the first byte landed", () => {
  const { logs, logger } = setup([1000, 1300, 9000])
  logger.onEvent()
  logger.onError(new Error("stream reset"))
  // The first-event line, then the failure line.
  assert.equal(logs.length, 2)
  assert.match(logs.at(-1).message, /1 events, first event after 300ms/)
  assert.match(logs.at(-1).message, /stream reset/)
})

test("a non-Error throwable is stringified rather than dropped", () => {
  const { logs, logger } = setup([1000, 2000])
  logger.onError("plain string failure")
  assert.match(logs[0].message, /plain string failure/)
})

test("tags every line with the turn id so lines correlate to the agent-trace span", () => {
  const { logs, logger } = setup([1000, 1100, 1200], { turnId: "turn-abc" })
  logger.onEvent()
  logger.onEnd()
  assert.ok(
    logs.every((l) => l.message.includes("session s1 turn turn-abc:")),
    "both lines carry the turn tag"
  )
})

test("omits the turn tag when the send carried no turn id", () => {
  const { logs, logger } = setup([1000, 1100])
  logger.onEvent()
  assert.match(logs[0].message, /^session s1: /)
})
