import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { spawn, spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./agent-proxy.mjs", import.meta.url))
const cleanup = []
let tlsMaterialPromise

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

function tlsMaterial() {
  tlsMaterialPromise ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-proxy-tls-"))
    const keyPath = path.join(dir, "key.pem")
    const certPath = path.join(dir, "cert.pem")
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
      ],
      { stdio: "ignore" }
    )
    assert.equal(generated.status, 0, "openssl must generate the local TLS test certificate")
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    return { key, cert }
  })()
  return tlsMaterialPromise
}

async function startProxy(status = 200, onRequest = () => {}) {
  let tlsServer
  let tlsPort
  if (status >= 200 && status < 300) {
    const material = await tlsMaterial()
    tlsServer = tls.createServer(material, (socket) => socket.end())
    await new Promise((resolve, reject) => {
      tlsServer.once("error", reject)
      tlsServer.listen(0, "127.0.0.1", resolve)
    })
    tlsPort = tlsServer.address().port
  }
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      onRequest(chunk.toString("latin1"))
      if (status < 200 || status >= 300) {
        socket.end(`HTTP/1.1 ${status} Denied\r\n\r\n`)
        return
      }
      const upstream = net.connect({ host: "127.0.0.1", port: tlsPort }, () => {
        socket.write(`HTTP/1.1 ${status} Connection Established\r\n\r\n`)
        socket.pipe(upstream).pipe(socket)
      })
      upstream.once("error", () => socket.destroy())
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  if (tlsServer) cleanup.push(() => new Promise((resolve) => tlsServer.close(resolve)))
  return server.address().port
}

async function startHeaderOnlyProxy() {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\n")
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  return server.address().port
}

async function makeCaptureAgent() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-proxy-test-"))
  const agent = path.join(dir, "capture-agent.mjs")
  await writeFile(
    agent,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
process.stdout.write(JSON.stringify({
  args,
  env: Object.fromEntries([
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    "NO_PROXY", "no_proxy",
  ].map((key) => [key, process.env[key]])),
}))
`
  )
  await chmod(agent, 0o755)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return agent
}

function run(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        AGENT_PROXY_URL: "",
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test("fails closed when no proxy is configured", async () => {
  const result = await run(["--check"])

  assert.equal(result.code, 2)
  assert.match(result.stderr, /AGENT_PROXY_URL/)
})

test("does not fall back to ambient standard proxy variables", async () => {
  const result = await run(["--check"], {
    HTTPS_PROXY: "http://127.0.0.1:7890",
    HTTP_PROXY: "http://127.0.0.1:7890",
  })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /AGENT_PROXY_URL/)
})

test("rejects SOCKS and non-loopback proxies", async () => {
  const socks = await run(["--check"], { AGENT_PROXY_URL: "socks5://127.0.0.1:7890" })
  assert.equal(socks.code, 2)
  assert.match(socks.stderr, /HTTP.*proxy/i)

  const remote = await run(["--check"], {
    AGENT_PROXY_URL: "http://proxy.example.com:8080",
  })
  assert.equal(remote.code, 2)
  assert.match(remote.stderr, /loopback/i)
})

test("refuses to launch when the proxy cannot establish the configured tunnel", async () => {
  const port = await startProxy(407)
  const result = await run(["--check"], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
  })

  assert.equal(result.code, 3)
  assert.match(result.stderr, /CONNECT.*407/i)
  assert.doesNotMatch(result.stdout, /"args"/)
})

test("rejects a proxy that returns CONNECT 200 but cannot carry tunnel traffic", async () => {
  const port = await startHeaderOnlyProxy()
  const result = await run(["--check"], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
  })

  assert.equal(result.code, 3)
  assert.match(result.stderr, /TLS|tunnel|socket|closed|reset/i)
})

test("launches any agent command through the pinned proxy with bypass variables cleared", async () => {
  const port = await startProxy()
  const agent = await makeCaptureAgent()
  const proxyUrl = `http://127.0.0.1:${port}`
  const result = await run(["--", process.execPath, agent, "--mode", "safe"], {
    AGENT_PROXY_URL: proxyUrl,
    NO_PROXY: "*",
    no_proxy: "localhost",
  })

  assert.equal(result.code, 0, result.stderr)
  const capture = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.deepEqual(capture.args, ["--mode", "safe"])
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    assert.equal(capture.env[key], proxyUrl)
  }
  assert.equal(capture.env.NO_PROXY, "")
  assert.equal(capture.env.no_proxy, "")
})

test("check mode validates the proxy and sandbox without requiring an agent command", async () => {
  const port = await startProxy()
  const result = await run(["--check"], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
    AGENT_PROXY_LAUNCHER: "/usr/bin/false",
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /ready/i)
  assert.doesNotMatch(result.stdout, /"args"/)
})

test("check mode tunnels to a caller-selected generic target", async () => {
  let request = ""
  const port = await startProxy(200, (value) => (request = value))
  const result = await run(["--check"], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
    AGENT_PROXY_CHECK_TARGET: "api.openai.com:443",
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(request, /^CONNECT api\.openai\.com:443 HTTP\/1\.1\r\n/)
})

test("rejects check targets with non-authority URL components", async () => {
  const port = await startProxy()
  const result = await run(["--check"], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
    AGENT_PROXY_CHECK_TARGET: "example.com:443/not-allowed?query=yes",
  })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /host:port/)
})

test("normal launch requires an agent command after the separator", async () => {
  const port = await startProxy()
  const result = await run([], {
    AGENT_PROXY_URL: `http://127.0.0.1:${port}`,
  })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /agent command/i)
})
