import assert from "node:assert/strict"
import test from "node:test"

import { BrowserLeaseController } from "./lease.mjs"

test("human takeover increments epoch and immediately preempts the agent", () => {
  let now = 1000
  const leases = new BrowserLeaseController({ now: () => now })
  const agent = leases.acquireAgent("agent-1")
  assert.equal(agent.epoch, 1)

  const human = leases.takeover("device-1")
  assert.equal(human.epoch, 2)
  assert.equal(human.controller.kind, "human")
  assert.equal(leases.validateInput(agent.epoch, "agent-1"), false)
  assert.equal(leases.validateInput(human.epoch, "device-1"), true)

  now += 30_001
  assert.equal(leases.current(), null)
})

test("agent lease lasts at most 15 seconds and human disconnect keeps five-second grace", () => {
  let now = 0
  const leases = new BrowserLeaseController({ now: () => now })
  leases.acquireAgent("agent-1", 60_000)
  now = 15_001
  assert.equal(leases.current(), null)

  const human = leases.takeover("device-1")
  leases.disconnect("device-1")
  now += 4_999
  assert.equal(leases.current()?.epoch, human.epoch)
  now += 2
  assert.equal(leases.current(), null)
})
