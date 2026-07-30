import assert from "node:assert/strict"
import test from "node:test"

import { createHostRpc, DEFAULT_HOST_RPC_TIMEOUT_MS } from "./host-rpc.mjs"

function harness(opts = {}) {
  const emitted = []
  const rpc = createHostRpc({ emit: (p) => emitted.push(p), ...opts })
  return { rpc, emitted }
}

test("call emits a host_rpc frame carrying the method and params", () => {
  const { rpc, emitted } = harness()
  rpc.call("jobs.spawn", { command: "echo hi" }).catch(() => {})

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, "host_rpc")
  assert.equal(emitted[0].method, "jobs.spawn")
  assert.deepEqual(emitted[0].params, { command: "echo hi" })
  assert.ok(emitted[0].rpcId, "every call carries a correlation id")
})

test("each call gets a distinct rpcId so concurrent calls do not collide", () => {
  const { rpc, emitted } = harness()
  rpc.call("a", {}).catch(() => {})
  rpc.call("b", {}).catch(() => {})
  assert.notEqual(emitted[0].rpcId, emitted[1].rpcId)
})

test("a matching host_rpc_result resolves the call with its result", async () => {
  const { rpc, emitted } = harness()
  const pending = rpc.call("jobs.list", {})
  const matched = rpc.resolveResult({
    type: "host_rpc_result",
    rpcId: emitted[0].rpcId,
    ok: true,
    result: { jobs: [{ id: "j1" }] },
  })

  assert.equal(matched, true)
  assert.deepEqual(await pending, { jobs: [{ id: "j1" }] })
  assert.equal(rpc.pendingCount, 0, "settled calls are removed from the map")
})

test("ok:false rejects with the host's error message", async () => {
  const { rpc, emitted } = harness()
  const pending = rpc.call("jobs.kill", { jobId: "nope" })
  rpc.resolveResult({
    type: "host_rpc_result",
    rpcId: emitted[0].rpcId,
    ok: false,
    error: "no job with id nope",
  })

  await assert.rejects(pending, /no job with id nope/)
})

test("results are routed to the right caller when several are in flight", async () => {
  const { rpc, emitted } = harness()
  const first = rpc.call("one", {})
  const second = rpc.call("two", {})

  // Answer out of order — routing must be by id, not arrival order.
  rpc.resolveResult({ rpcId: emitted[1].rpcId, ok: true, result: "second" })
  rpc.resolveResult({ rpcId: emitted[0].rpcId, ok: true, result: "first" })

  assert.equal(await first, "first")
  assert.equal(await second, "second")
})

test("an unknown rpcId is ignored rather than throwing", () => {
  const { rpc } = harness()
  assert.equal(rpc.resolveResult({ rpcId: "ghost", ok: true, result: 1 }), false)
  assert.equal(rpc.resolveResult({}), false)
  assert.equal(rpc.resolveResult(null), false)
})

test("a late reply after a timeout is ignored and does not throw", async () => {
  const { rpc, emitted } = harness({ timeoutMs: 10 })
  const pending = rpc.call("slow", {})
  await assert.rejects(pending, /timed out after 10 ms/)

  // The host eventually answers; nothing is listening and that must be safe.
  assert.equal(rpc.resolveResult({ rpcId: emitted[0].rpcId, ok: true, result: 1 }), false)
})

test("a call times out on its own budget, overriding the client default", async () => {
  const { rpc } = harness({ timeoutMs: DEFAULT_HOST_RPC_TIMEOUT_MS })
  // A long-poll passes its own, shorter-than-default budget here.
  await assert.rejects(rpc.call("bash_output", {}, { timeoutMs: 15 }), /timed out after 15 ms/)
})

test("timing out frees the pending slot so the map cannot leak", async () => {
  const { rpc } = harness({ timeoutMs: 5 })
  await assert.rejects(rpc.call("x", {}), /timed out/)
  assert.equal(rpc.pendingCount, 0)
})

test("rejectAll fails every in-flight call when the channel drops", async () => {
  const { rpc } = harness()
  const a = rpc.call("a", {})
  const b = rpc.call("b", {})
  rpc.rejectAll("sidecar closing")

  await assert.rejects(a, /sidecar closing/)
  await assert.rejects(b, /sidecar closing/)
  assert.equal(rpc.pendingCount, 0)
})

test("calls after close reject immediately instead of hanging forever", async () => {
  const { rpc, emitted } = harness()
  rpc.rejectAll("closed")
  assert.equal(rpc.isClosed, true)

  await assert.rejects(rpc.call("a", {}), /channel is closed/)
  assert.equal(emitted.length, 0, "a closed channel emits nothing")
})
