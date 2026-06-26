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
