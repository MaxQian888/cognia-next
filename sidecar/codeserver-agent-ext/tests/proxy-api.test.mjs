import assert from "node:assert/strict"
import test from "node:test"

import { proxyApi } from "../src/proxy-api.mjs"

const broker = { languages: {}, debug: {}, name: "broker" }

test("registers through the proxy's own API when it passed one", () => {
  const proxy = { languages: {}, debug: {}, name: "proxy" }
  assert.equal(proxyApi(proxy, broker), proxy)
})

test("falls back to the broker's API for a proxy that passed none or something else", () => {
  assert.equal(proxyApi(undefined, broker), broker)
  assert.equal(proxyApi(null, broker), broker)
  assert.equal(proxyApi("vscode", broker), broker)
  assert.equal(proxyApi({ languages: {} }, broker), broker)
})
