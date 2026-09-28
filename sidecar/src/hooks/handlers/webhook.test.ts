import type { AddressInfo } from "node:net"
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { runWebhookHandler } from "../agent-hooks.ts"

test("runWebhookHandler: 2xx JSON body parsed, non-2xx warns", async () => {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ additionalContext: `saw:${body}` }))
      } else {
        res.writeHead(500)
        res.end("boom")
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  try {
    const ok = await runWebhookHandler(`http://127.0.0.1:${port}/ok`, {}, 5, '{"x":1}')
    assert.equal(ok.additionalContext, 'saw:{"x":1}')
    const bad = await runWebhookHandler(`http://127.0.0.1:${port}/err`, undefined, 5, "{}")
    assert.match(bad.warning!, /500/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test("runWebhookHandler: redacts a PII-bearing lifecycle payload before fetch", async () => {
  let received = ""
  const server = http.createServer((req, res) => {
    req.on("data", (chunk) => (received += chunk))
    req.on("end", () => {
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const out = await runWebhookHandler(
      `http://127.0.0.1:${port}/hook`,
      undefined,
      5,
      JSON.stringify({ prompt: "email alice@example.com" })
    )
    assert.equal(out.block, undefined)
    assert.doesNotMatch(received, /alice@example\.com/)
    assert.match(received, /<EMAIL_001>/)
  } finally {
    server.close()
  }
})
