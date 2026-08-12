import assert from "node:assert/strict"
import test from "node:test"

import { assessListenerOutput } from "./listener-safety.mjs"

test("assessListenerOutput accepts loopback-only CDP listeners", () => {
  assert.deepEqual(
    assessListenerOutput("ChatGPT 123 user 42u IPv4 0x0 0t0 TCP 127.0.0.1:9229 (LISTEN)", 9229),
    { listening: true, loopbackOnly: true, addresses: ["127.0.0.1:9229"] }
  )
})

test("assessListenerOutput rejects wildcard or externally reachable listeners", () => {
  assert.equal(
    assessListenerOutput("ChatGPT 123 user 42u IPv6 0x0 0t0 TCP *:9229 (LISTEN)", 9229)
      .loopbackOnly,
    false
  )
  assert.equal(
    assessListenerOutput("ChatGPT 123 user 42u IPv4 0x0 0t0 TCP 192.168.1.5:9229 (LISTEN)", 9229)
      .loopbackOnly,
    false
  )
})
