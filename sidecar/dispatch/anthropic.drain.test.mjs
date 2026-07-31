// Unit tests for `drainPendingRoundTrips` — the immediate teardown drain the
// host's interrupt/close handlers call on the Anthropic session. Kept separate
// from `anthropic.live.test.mjs` (which boots the real CLI) so the pure drain
// semantics run without network or a subprocess.

import { test } from "node:test"
import assert from "node:assert/strict"

import { drainPendingRoundTrips } from "./anthropic.mjs"

test("drainPendingRoundTrips denies pending approvals and clears the map", () => {
  const results = []
  const pendingApprovals = new Map([
    ["r1", { resolve: (r) => results.push(["r1", r]) }],
    ["r2", { resolve: (r) => results.push(["r2", r]) }],
  ])
  drainPendingRoundTrips({ pendingApprovals }, "interrupted")
  assert.equal(pendingApprovals.size, 0)
  // Map iteration is insertion order, so the resolutions are deterministic.
  assert.deepEqual(results, [
    ["r1", { behavior: "deny", message: "interrupted" }],
    ["r2", { behavior: "deny", message: "interrupted" }],
  ])
})

test("drainPendingRoundTrips resolves pending plugin tool calls with an error envelope", () => {
  const results = []
  const pendingPluginToolCalls = new Map([["t1", { resolve: (r) => results.push(r) }]])
  drainPendingRoundTrips({ pendingPluginToolCalls }, "session closed")
  assert.equal(pendingPluginToolCalls.size, 0)
  // The `{ error }` shape is what `plugin-tools.mjs` surfaces as a tool error.
  assert.deepEqual(results, [{ error: "session closed" }])
})

test("drainPendingRoundTrips drains both maps and defaults the reason", () => {
  const approvals = []
  const plugins = []
  const pendingApprovals = new Map([["a", { resolve: (r) => approvals.push(r) }]])
  const pendingPluginToolCalls = new Map([["p", { resolve: (r) => plugins.push(r) }]])
  drainPendingRoundTrips({ pendingApprovals, pendingPluginToolCalls })
  assert.deepEqual(approvals, [{ behavior: "deny", message: "interrupted" }])
  assert.deepEqual(plugins, [{ error: "interrupted" }])
})

test("drainPendingRoundTrips tolerates missing maps / no args (no throw)", () => {
  assert.doesNotThrow(() => drainPendingRoundTrips())
  assert.doesNotThrow(() => drainPendingRoundTrips({}))
  const results = []
  // Only one map present — the other being undefined must be a no-op.
  drainPendingRoundTrips({
    pendingApprovals: new Map([["x", { resolve: (r) => results.push(r) }]]),
  })
  assert.deepEqual(results, [{ behavior: "deny", message: "interrupted" }])
})

test("drainPendingRoundTrips notifies interrupted requestIds BEFORE resolving each deny", () => {
  const order = []
  const pendingApprovals = new Map([
    ["r1", { resolve: () => order.push("resolve:r1") }],
    ["r2", { resolve: () => order.push("resolve:r2") }],
  ])
  drainPendingRoundTrips({ pendingApprovals }, "session closed", (id) => order.push(`notify:${id}`))
  assert.deepEqual(order, ["notify:r1", "resolve:r1", "notify:r2", "resolve:r2"])
})

test("drainPendingRoundTrips does not notify for plugin tool calls", () => {
  const notified = []
  const pendingPluginToolCalls = new Map([["t1", { resolve: () => {} }]])
  drainPendingRoundTrips({ pendingPluginToolCalls }, "closed", (id) => notified.push(id))
  assert.deepEqual(notified, [])
})

test("drainPendingRoundTrips survives a throwing notifier (deny still resolves)", () => {
  const results = []
  const pendingApprovals = new Map([["r1", { resolve: (r) => results.push(r) }]])
  assert.doesNotThrow(() =>
    drainPendingRoundTrips({ pendingApprovals }, "interrupted", () => {
      throw new Error("notifier boom")
    })
  )
  assert.equal(pendingApprovals.size, 0)
  assert.deepEqual(results, [{ behavior: "deny", message: "interrupted" }])
})

test("drainPendingRoundTrips is defensive against a throwing resolver (still clears the map)", () => {
  const ok = []
  const pendingApprovals = new Map([
    [
      "bad",
      {
        resolve: () => {
          throw new Error("boom")
        },
      },
    ],
    ["good", { resolve: (r) => ok.push(r) }],
  ])
  assert.doesNotThrow(() => drainPendingRoundTrips({ pendingApprovals }))
  assert.equal(pendingApprovals.size, 0, "a throwing resolver must not block draining the rest")
  assert.deepEqual(ok, [{ behavior: "deny", message: "interrupted" }])
})
