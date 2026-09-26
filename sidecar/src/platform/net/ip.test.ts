import { test } from "node:test"
import assert from "node:assert/strict"

import { cidrContains, parseCidr, parseIp } from "./ip.ts"

test("parseIp reads IPv4 and IPv6 literals and rejects names", () => {
  assert.deepEqual(parseIp("10.0.0.1"), { bits: 32, value: 0x0a000001n })
  assert.deepEqual(parseIp("::1"), { bits: 128, value: 1n })
  assert.deepEqual(parseIp("[::1]"), { bits: 128, value: 1n })
  assert.deepEqual(parseIp("::ffff:10.0.0.1"), { bits: 128, value: 0xffff0a000001n })
  assert.equal(parseIp("localhost"), null)
  assert.equal(parseIp("256.0.0.1"), null)
  assert.equal(parseIp("1..2.3"), null)
  assert.equal(parseIp("1:2:3"), null)
  assert.equal(parseIp("1::2::3"), null)
})

test("parseCidr validates the prefix against the address family", () => {
  assert.deepEqual(parseCidr("127.0.0.0/8"), { bits: 32, value: 0x7f000000n, prefix: 8 })
  assert.equal(parseCidr("127.0.0.0/33"), null)
  assert.equal(parseCidr("fd00::/129"), null)
  assert.equal(parseCidr("/8"), null)
  assert.equal(parseCidr("127.0.0.1"), null)
})

test("cidrContains matches same-family addresses inside the prefix only", () => {
  const loopback = parseCidr("127.0.0.0/8")
  assert.ok(loopback)
  assert.equal(cidrContains(loopback, "127.4.5.6"), true)
  assert.equal(cidrContains(loopback, "128.0.0.1"), false)
  assert.equal(cidrContains(loopback, "::1"), false)
  assert.equal(cidrContains(loopback, "example.com"), false)
  const ula = parseCidr("fd00::/8")
  assert.ok(ula)
  assert.equal(cidrContains(ula, "[fd12::1]"), true)
})
