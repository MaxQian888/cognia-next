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
import { spawn } from "node:child_process"
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

function runIsolatedInterceptor(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        NO_PROXY: "",
        no_proxy: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
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

  // Env MUST be set before importing the interceptor — its undici dispatcher
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
  // Agent here. It must already be a proxy-aware dispatcher (the wrapper is
  // needed when NO_PROXY contains exact IP/CIDR rules).
  const dispatcher = getGlobalDispatcher()
  assert.notEqual(dispatcher.constructor.name, "Agent")
  assert.equal(typeof dispatcher.dispatch, "function")
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

test("supports IP/CIDR bypass without weakening all other proxy routing", async () => {
  const moduleUrl = new URL("./fetch-interceptor.mjs", import.meta.url).href
  const result = await runIsolatedInterceptor(
    `await import(${JSON.stringify(moduleUrl)});
     const response = await fetch(${JSON.stringify(`http://127.0.0.1:${originPort}/cidr`)});
     process.stdout.write("body=" + await response.text());`,
    {
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.0/8",
    }
  )

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /body=origin-ok/)
})

test("redacts proxy userinfo from startup diagnostics", async () => {
  const moduleUrl = new URL("./fetch-interceptor.mjs", import.meta.url).href
  const result = await runIsolatedInterceptor(`await import(${JSON.stringify(moduleUrl)});`, {
    HTTP_PROXY: "http://alice:top-secret@127.0.0.1:9",
    HTTPS_PROXY: "http://alice:top-secret@127.0.0.1:9",
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /"target":"http:\/\/127\.0\.0\.1:9"/)
  assert.doesNotMatch(result.stdout, /alice|top-secret/)
})

test("fails sidecar startup instead of falling back direct for an invalid active proxy", async () => {
  const moduleUrl = new URL("./fetch-interceptor.mjs", import.meta.url).href
  const result = await runIsolatedInterceptor(
    `try {
       await import(${JSON.stringify(moduleUrl)});
       process.exitCode = 0;
     } catch (error) {
       process.stderr.write(String(error?.message ?? error));
       process.exitCode = 42;
     }`,
    {
      HTTP_PROXY: "not-a-proxy-url-with-secret",
      HTTPS_PROXY: "not-a-proxy-url-with-secret",
    }
  )

  assert.equal(result.code, 42)
  assert.match(result.stderr, /^PROXY_INVALID_CONFIG:/)
  assert.doesNotMatch(result.stderr, /with-secret/)
})
