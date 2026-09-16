// Router + Fusion (ADR-0188): the host routes the renderer's reservation
// decision to the live session that asked, and ignores everything else.

import assert from "node:assert/strict"
import test from "node:test"

import { routeCallReserveDecision, routeSendIntoLiveLoop } from "./agent-host.mjs"
import * as shim from "./claude-host.mjs"

test("routes a reservation decision to the session's resolver", () => {
  const seen = []
  const sessions = new Map([
    ["s1", { resolveCallReserve: (msg) => (seen.push(msg), true) }],
    ["legacy", {}],
  ])
  const decision = { sessionId: "s1", requestId: "r1", decision: "granted", attemptId: "a1" }
  assert.equal(routeCallReserveDecision(sessions, decision), true)
  assert.deepEqual(seen, [decision])
  assert.equal(routeCallReserveDecision(sessions, { sessionId: "legacy", requestId: "r2" }), false)
  assert.equal(routeCallReserveDecision(sessions, { sessionId: "gone", requestId: "r3" }), false)
  assert.equal(routeCallReserveDecision(sessions, null), false)
})

test("a live loop is handed this send's turn id and ledger stamp before the prompt", () => {
  const order = []
  const loop = {
    turnRef: { id: "turn-1" },
    setNextTurnLedger: (ledger) => order.push(["ledger", ledger]),
    pushUserMessage: (prompt) => order.push(["prompt", prompt]),
  }
  const ledger = { runId: "run-2", mode: "per_call" }
  routeSendIntoLiveLoop(loop, { turnId: "turn-2", ledger }, "again")
  assert.equal(loop.turnRef.id, "turn-2")
  assert.deepEqual(order, [
    ["ledger", ledger],
    ["prompt", "again"],
  ])

  // A switched-off surface sends no stamp, and the loop must be told so rather
  // than keeping the previous turn's run.
  order.length = 0
  routeSendIntoLiveLoop(loop, { turnId: "turn-3" }, "third")
  assert.deepEqual(order, [
    ["ledger", undefined],
    ["prompt", "third"],
  ])
})

test("a loop with no ledger seam still takes the prompt", () => {
  const pushed = []
  // No turnRef either: a dispatcher that predates both seams.
  routeSendIntoLiveLoop({ pushUserMessage: (p) => pushed.push(p) }, undefined, "hi")
  assert.deepEqual(pushed, ["hi"])
})

test("the compatibility shim re-exports the router", () => {
  assert.equal(shim.routeCallReserveDecision, routeCallReserveDecision)
  assert.equal(shim.routeSendIntoLiveLoop, routeSendIntoLiveLoop)
})
