// `installEnvProxy`: how extensions' traffic is routed from the proxy the host
// was started with.
import assert from "node:assert/strict"
import { test } from "node:test"

import { DEAD_END_PROXY, installEnvProxy } from "../dist/network.js"

function recorder({ throwsFor } = {}) {
  const calls = []
  const set = (env) => {
    calls.push({ ...env })
    if (throwsFor && env.HTTP_PROXY === throwsFor) throw new Error("bad proxy")
    return () => {}
  }
  return { calls, set }
}

test("no proxy configured: traffic goes direct and nothing is installed", () => {
  const { calls, set } = recorder()
  assert.equal(
    installEnvProxy({}, set, () => {}),
    "direct"
  )
  assert.deepEqual(calls, [])
})

test("a proxy configured: it is installed for every client", () => {
  const { calls, set } = recorder()
  const env = { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "localhost" }
  assert.equal(
    installEnvProxy(env, set, () => {}),
    "proxy"
  )
  assert.deepEqual(calls, [env])
})

test("unusable proxy settings send traffic nowhere rather than straight out", () => {
  const { calls, set } = recorder({ throwsFor: "not a url" })
  const warnings = []
  assert.equal(
    installEnvProxy({ HTTP_PROXY: "not a url" }, set, (message) => warnings.push(message)),
    "dead-end"
  )
  assert.deepEqual(calls.at(-1), { HTTP_PROXY: DEAD_END_PROXY, HTTPS_PROXY: DEAD_END_PROXY })
  assert.match(warnings[0], /proxy settings are unusable \(bad proxy\)/)
})

test("a Node without a global proxy says the traffic will not go through it", () => {
  const warnings = []
  assert.equal(
    installEnvProxy({ HTTP_PROXY: "http://proxy:8080" }, null, (message) => warnings.push(message)),
    "unproxied"
  )
  assert.match(warnings[0], /cannot use a proxy/)
})
