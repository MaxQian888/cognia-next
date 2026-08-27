import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import {
  collectRepliesForWindow,
  createLease,
  observedReply,
  waitForMarkedReply,
} from "./observe.mjs"

const MARKER = buildMarker("telegram", "aa", 1)
const noSleep = async () => {}

/** A driver whose poll returns one scripted batch per call. */
function scriptedDriver(batches) {
  let index = 0
  return {
    calls: () => index,
    pollTargetMessages: async () => batches[index++] ?? [],
  }
}

test("observedReply normalizes ids to strings and fills the optional fields", () => {
  assert.deepEqual(observedReply({ messageId: 1234, text: "hi" }), {
    messageId: "1234",
    text: "hi",
    at: null,
    threadId: null,
  })
})

test("createLease starts with empty accumulators and keeps driver extras", () => {
  const lease = createLease({ platform: "slack", conversationId: "C1", extra: { cursor: "0" } })
  assert.deepEqual(lease.observed, [])
  assert.deepEqual(lease.sentMessageIds, [])
  assert.equal(lease.cursor, "0")
})

test("waitForMarkedReply returns the marked reply once it appears", async () => {
  const driver = scriptedDriver([[], [observedReply({ messageId: 1, text: `echo ${MARKER}` })]])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  const reply = await waitForMarkedReply(driver, lease, {
    marker: MARKER,
    timeoutMs: 5000,
    intervalMs: 1,
    sleepImpl: noSleep,
  })
  assert.equal(reply.messageId, "1")
})

test("waitForMarkedReply ignores messages that are not this run's", async () => {
  const other = buildMarker("telegram", "bb", 1)
  const driver = scriptedDriver([
    [observedReply({ messageId: 9, text: `not mine ${other}` })],
    [observedReply({ messageId: 10, text: `mine ${MARKER}` })],
  ])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  const reply = await waitForMarkedReply(driver, lease, {
    marker: MARKER,
    timeoutMs: 5000,
    intervalMs: 1,
    sleepImpl: noSleep,
  })
  assert.equal(reply.messageId, "10")
  assert.equal(lease.observed.length, 2, "both messages stay on the lease as evidence")
})

test("waitForMarkedReply returns null on timeout", async () => {
  let t = 0
  const driver = scriptedDriver([])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  assert.equal(
    await waitForMarkedReply(driver, lease, {
      marker: MARKER,
      timeoutMs: 20,
      intervalMs: 10,
      now: () => (t += 10),
      sleepImpl: noSleep,
    }),
    null
  )
})

test("collectRepliesForWindow burns the whole window so a late duplicate is caught", async () => {
  let t = 0
  const driver = scriptedDriver([
    [observedReply({ messageId: 1, text: `first ${MARKER}` })],
    [],
    [observedReply({ messageId: 2, text: `duplicate ${MARKER}` })],
  ])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  const all = await collectRepliesForWindow(driver, lease, {
    windowMs: 30,
    intervalMs: 10,
    now: () => (t += 10),
    sleepImpl: noSleep,
  })
  assert.equal(all.length, 2, "the second reply must not be missed by an early return")
  assert.equal(driver.calls(), 3)
})

test("collectRepliesForWindow polls at least once with a zero window", async () => {
  const driver = scriptedDriver([[observedReply({ messageId: 1, text: MARKER })]])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  const all = await collectRepliesForWindow(driver, lease, { windowMs: 0, sleepImpl: noSleep })
  assert.equal(all.length, 1)
})

test("collectRepliesForWindow keeps replies already observed while waiting", async () => {
  const driver = scriptedDriver([[]])
  const lease = createLease({ platform: "telegram", conversationId: "1" })
  lease.observed.push(observedReply({ messageId: 7, text: `earlier ${MARKER}` }))
  const all = await collectRepliesForWindow(driver, lease, { windowMs: 0, sleepImpl: noSleep })
  assert.deepEqual(
    all.map((r) => r.messageId),
    ["7"]
  )
})
