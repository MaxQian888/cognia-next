import test from "node:test"
import assert from "node:assert/strict"
import { routeSendIntoLiveLoop } from "../host/sessions/lifecycle.ts"
import { routeCallReserveDecision } from "../host/commands/responses.ts"
import { startAgentHost, emitObservers, emitForTests } from "./agent-host.ts"
import * as shim from "../../claude-host.mjs"

test("the claude-host shim re-exports the full agent-host surface", () => {
  for (const name of [
    "makeWrappedEmit",
    "restartReason",
    "routeClose",
    "routeRestore",
    "routeSteer",
    "buildPermissionResult",
    "startAgentHost",
    "dropDuplicateCommand",
    "blockUnsupportedCommand",
  ]) {
    assert.equal(typeof shim[name as keyof typeof shim], "function", `shim must re-export ${name}`)
  }
  assert.equal(shim.startAgentHost, startAgentHost, "same function object, not a copy")
})

test("startAgentHost is exported and idempotent by contract (guard flag)", () => {
  // We cannot start the real stdin loop in a test process; assert the export
  // exists and is a zero-arg function (the shim + packaged-CLI role rely on
  // calling it more than once safely — see the hostStarted guard).
  assert.equal(typeof startAgentHost, "function")
  assert.equal(startAgentHost.length, 0)
})

test("emitObservers see every frame and cannot break the wire", () => {
  const seen: unknown[] = []
  const observer = (payload: unknown) => seen.push((payload as { type: string }).type)
  const thrower = () => {
    throw new Error("observer bug")
  }
  emitObservers.add(observer)
  emitObservers.add(thrower)
  try {
    const originalWrite = process.stdout.write
    process.stdout.write = () => true
    try {
      emitForTests({ type: "log", level: "info", message: "hi" })
    } finally {
      process.stdout.write = originalWrite
    }
  } finally {
    emitObservers.delete(observer)
    emitObservers.delete(thrower)
  }
  assert.deepEqual(seen, ["log"])
})

test("the compatibility shim re-exports the router", () => {
  assert.equal(shim.routeCallReserveDecision, routeCallReserveDecision)
  assert.equal(shim.routeSendIntoLiveLoop, routeSendIntoLiveLoop)
})
