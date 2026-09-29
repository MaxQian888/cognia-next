import assert from "node:assert/strict"
import test from "node:test"

import { DomainBlockedError, NetworkPolicy } from "./network-policy.mjs"

const publicDns = async () => ["93.184.216.34"]

test("allows runtime loopback and explicitly granted public domains", async () => {
  const policy = new NetworkPolicy({ resolve: publicDns })
  await assert.doesNotReject(() => policy.authorize("http://localhost:3000/app", []))
  const result = await policy.authorize("https://app.example.com/login", ["app.example.com"])
  assert.equal(result.address, "93.184.216.34")
})

test("blocks ungranted public domains and top-level redirects", async () => {
  const policy = new NetworkPolicy({ resolve: publicDns })
  await assert.rejects(() => policy.authorize("https://example.com", []), DomainBlockedError)
  await assert.rejects(
    () =>
      policy.authorizeRedirect("https://allowed.example", "https://evil.example", [
        "allowed.example",
      ]),
    (error) => error.code === "domain_blocked"
  )
})

test("always blocks private, link-local, metadata, and rebinding answers", async () => {
  for (const address of [
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "fc00::1",
    "fe80::1",
  ]) {
    const policy = new NetworkPolicy({ resolve: async () => [address] })
    await assert.rejects(
      () => policy.authorize("https://granted.example", ["granted.example"]),
      (error) => error.code === "network_address_blocked"
    )
  }

  const rebinding = new NetworkPolicy({ resolve: async () => ["93.184.216.34", "127.0.0.1"] })
  await assert.rejects(
    () => rebinding.authorize("https://granted.example", ["granted.example"]),
    (error) => error.code === "network_address_blocked"
  )
})

test("rejects wildcard grants because every authorized host must be DNS-pinned", async () => {
  const policy = new NetworkPolicy({ resolve: publicDns })
  await assert.rejects(
    () => policy.resolverRules(["*.example.com"]),
    (error) => error.code === "domain_grant_invalid"
  )
})

test("local policy allows any http(s) origin and polices only schemes", async () => {
  const { LocalNetworkPolicy } = await import("./network-policy.mjs")
  const policy = new LocalNetworkPolicy()
  assert.equal((await policy.authorize("https://example.com/")).loopback, false)
  assert.equal((await policy.authorize("http://127.0.0.2:5173/")).loopback, true)
  assert.equal((await policy.authorize("http://app.localhost:3000/")).loopback, true)
  assert.equal((await policy.authorize("http://192.168.1.20:8080/")).loopback, false)
  await assert.doesNotReject(() => policy.authorize("about:blank"))
  await assert.rejects(
    () => policy.authorize("file:///etc/hosts"),
    (error) => error.code === "file_url_blocked"
  )
  await assert.rejects(
    () => policy.authorize("chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html"),
    (error) => error.code === "url_scheme_blocked"
  )
  await assert.rejects(
    () => policy.authorize("javascript:alert(1)"),
    (error) => error.code === "url_scheme_blocked"
  )
  await assert.rejects(
    () => policy.authorize("chrome://settings"),
    (error) => error.code === "url_scheme_blocked"
  )
  await assert.rejects(
    () => policy.authorize("not a url"),
    (error) => error.code === "url_invalid"
  )
  assert.equal(await policy.resolverRules(), "")
})

test("local policy opens file:// and extension pages only when allowed", async () => {
  const { LocalNetworkPolicy } = await import("./network-policy.mjs")
  const policy = new LocalNetworkPolicy({ allowFileUrls: true, allowExtensionUrls: true })
  assert.equal((await policy.authorize("file:///tmp/index.html")).url, "file:///tmp/index.html")
  await assert.doesNotReject(() =>
    policy.authorize("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html")
  )
  await assert.rejects(
    () => policy.authorizeRedirect("https://a.example", "data:text/html,hi"),
    (error) => error.code === "url_scheme_blocked"
  )
})
