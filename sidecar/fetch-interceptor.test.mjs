// Proxy/geo-consistency tests for fetch-interceptor.mjs.
//
// The interceptor routes the sidecar's *in-process* fetch (the ai-sdk
// dispatch path used by every non-Anthropic provider) through the user's
// configured proxy, so its outbound geo matches the Anthropic-CLI path.
// These tests assert two invariants the original implementation broke:
//
//   1. Deterministic install — by the time the importing module continues,
//      the proxy dispatcher MUST already be installed (no fire-and-forget
//      race that lets the first request leak direct).
//   2. Bypass is honoured — hosts in NO_PROXY (localhost / local providers)
//      go direct; everything else is tunnelled through the proxy.
//
// undici tunnels ALL targets (http and https) to the proxy via CONNECT, so
// the fake proxy below handles `connect` and pipes to a local origin.
//
// Run: node --test fetch-interceptor.test.mjs

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"

let connectHits = []
let originHits = []
let proxyServer
let originServer
let originPort

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  )
}

before(async () => {
  originServer = http.createServer((req, res) => {
    originHits.push(req.url)
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("origin-ok")
  })
  originPort = await listen(originServer)

  // Fake forward proxy: record CONNECT targets and tunnel them to the local
  // origin (ignoring the requested host — we only need to prove routing).
  proxyServer = http.createServer((_req, res) => {
    res.writeHead(400)
    res.end("expected CONNECT")
  })
  proxyServer.on("connect", (req, clientSocket, head) => {
    connectHits.push(req.url)
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("error", () => upstream.destroy())
  })
  const proxyPort = await listen(proxyServer)

  // Env MUST be set before importing the interceptor — EnvHttpProxyAgent
  // snapshots HTTP(S)_PROXY / NO_PROXY at construction.
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.NO_PROXY = "127.0.0.1,localhost"

  await import("./fetch-interceptor.mjs")
})

after(async () => {
  // Close undici's keep-alive sockets first so the event loop can drain and
  // the process exits cleanly (no --test-force-exit, which aborts libuv on
  // Windows when handles are still open).
  try {
    const { getGlobalDispatcher } = await import("undici")
    await getGlobalDispatcher().close()
  } catch {
    // ignore — dispatcher may already be closed.
  }
  await new Promise((r) => proxyServer?.close(r))
  await new Promise((r) => originServer?.close(r))
})

test("installs the proxy dispatcher deterministically (no race)", async () => {
  const { getGlobalDispatcher } = await import("undici")
  // If install were fire-and-forget, the dispatcher would still be the default
  // Agent here. It must be the env-proxy agent, installed synchronously.
  assert.equal(getGlobalDispatcher().constructor.name, "EnvHttpProxyAgent")
})

test("tunnels a non-bypassed host through the proxy", async () => {
  connectHits = []
  originHits = []
  const res = await fetch("http://geo-proxied.test/v1/chat")
  const body = await res.text()
  assert.equal(body, "origin-ok")
  assert.ok(
    connectHits.some((u) => u.startsWith("geo-proxied.test")),
    `expected a CONNECT for the target host, got: ${JSON.stringify(connectHits)}`
  )
})

test("bypasses the proxy for NO_PROXY hosts (local providers)", async () => {
  connectHits = []
  originHits = []
  const res = await fetch(`http://127.0.0.1:${originPort}/v1/models`)
  const body = await res.text()
  assert.equal(body, "origin-ok")
  assert.ok(originHits.length > 0, "expected the origin to receive a direct request")
  assert.equal(connectHits.length, 0, "local-provider traffic must NOT tunnel through the proxy")
})
