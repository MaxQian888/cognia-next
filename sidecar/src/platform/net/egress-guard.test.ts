import { test } from "node:test"
import assert from "node:assert/strict"
import type { LookupFunction } from "node:net"

import { createEgressGuard, isPrivateOrReservedHost, validateRemoteUrl } from "./egress-guard.ts"
import type { GuardAgentConstructor, LookupAll } from "./egress-guard.ts"

/** A fake pool constructor recording the options the guard builds it with. */
function fakeAgent(dispatcher: object): {
  AgentCtor: GuardAgentConstructor
  options: () => { connect: { lookup: LookupFunction } } | undefined
} {
  let seen: { connect: { lookup: LookupFunction } } | undefined
  class FakeAgent {
    constructor(options: { connect: { lookup: LookupFunction } }) {
      seen = options
      return dispatcher
    }
  }
  // The fake stands in for undici's Agent; the guard only passes it to fetch and closes it.
  return { AgentCtor: FakeAgent as unknown as GuardAgentConstructor, options: () => seen }
}

function lookupReturning(addresses: { address: string; family: number }[]): LookupAll {
  return (_hostname, _options, callback) => callback(null, addresses)
}

test("isPrivateOrReservedHost classifies loopback, private, link-local and reserved targets", () => {
  for (const host of [
    "localhost",
    "api.localhost",
    "printer.local",
    "[::1]",
    "::",
    "fd12::1",
    "fe80::1",
    "::ffff:8.8.8.8",
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedHost(host), true, host)
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateOrReservedHost(host), false, host)
  }
})

test("OAuth egress rejects insecure and private endpoints unless explicitly reviewed", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/mcp"), /HTTPS/)
  assert.throws(() => validateRemoteUrl("https://127.0.0.1/mcp"), /private or reserved/)
  assert.equal(validateRemoteUrl("http://127.0.0.1/mcp", true).href, "http://127.0.0.1/mcp")
  assert.throws(() => validateRemoteUrl("http://example.com/mcp", true), /HTTPS/)
  assert.throws(() => validateRemoteUrl("not a url"), /not a valid URL/)
})

test("guarded OAuth fetch denies redirects and carries a socket-level DNS guard", async () => {
  const dispatcher = { close: async () => undefined }
  const agent = fakeAgent(dispatcher)
  let receivedInit: RequestInit | undefined
  const guard = createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([{ address: "127.0.0.1", family: 4 }]),
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return new Response(null)
    },
  })
  await guard.fetch("https://example.com/token", { redirect: "follow" })
  assert.equal(receivedInit?.redirect, "error")
  assert.equal((receivedInit as { dispatcher?: unknown } | undefined)?.dispatcher, dispatcher)
  const lookup = agent.options()?.connect.lookup
  assert.equal(typeof lookup, "function")
  const lookupError = await new Promise<Error | null>((resolve) => {
    lookup?.("rebinding.example", {}, (error) => resolve(error))
  })
  assert.match(lookupError?.message ?? "", /private or reserved/)
  await guard.close()
})

test("the guarded lookup answers in the caller's requested shape", async () => {
  const agent = fakeAgent({ close: async () => undefined })
  await createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]),
    fetchImpl: async () => new Response(null),
  }).fetch("https://example.com/")
  const lookup = agent.options()?.connect.lookup
  assert.ok(lookup)
  const single = await new Promise((resolve) =>
    lookup("example.com", {}, (error, address, family) => resolve({ error, address, family }))
  )
  assert.deepEqual(single, { error: null, address: "93.184.216.34", family: 4 })
  const all = await new Promise((resolve) =>
    lookup("example.com", { all: true }, (error, address) => resolve({ error, address }))
  )
  assert.deepEqual(all, {
    error: null,
    address: [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ],
  })
  const empty = createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([]),
    fetchImpl: async () => new Response(null),
  })
  await empty.fetch("https://example.com/")
  const noAddresses = await new Promise<Error | null>((resolve) =>
    agent.options()?.connect.lookup("example.com", {}, (error) => resolve(error))
  )
  assert.match(noAddresses?.message ?? "", /returned no addresses/)
})

test("a reviewed private server skips the guarded pool but still refuses redirects", async () => {
  let built = false
  class NeverBuilt {
    constructor() {
      built = true
    }
  }
  let receivedInit: RequestInit | undefined
  const guard = createEgressGuard({
    allowPrivateNetwork: true,
    AgentCtor: NeverBuilt as unknown as GuardAgentConstructor,
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return new Response(null)
    },
  })
  await guard.fetch("http://127.0.0.1:8080/mcp")
  assert.equal(built, false)
  assert.equal(receivedInit?.redirect, "error")
  assert.equal("dispatcher" in (receivedInit ?? {}), false)
  await guard.close()
})
