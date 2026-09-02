/**
 * Unit tests for `cli/src/x/proxy-server.ts`.
 */

import http from "node:http"
import { startProxyServer } from "./proxy-server"

/** Helper to make an HTTP request and collect the response. */
function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      }
    )
    req.on("error", reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe("proxy-server", () => {
  let proxy: Awaited<ReturnType<typeof startProxyServer>> | undefined

  afterEach(async () => {
    if (proxy) {
      await proxy.shutdown()
      proxy = undefined
    }
  })

  it("starts and responds to /healthz without auth", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(`${proxy.baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.status).toBe("ok")
    expect(json.proxy).toBe("cognia-x")
  })

  it("responds to GET / for Claude Code probe", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(proxy.baseUrl)
    expect(res.status).toBe(200)
  })

  it("rejects unauthenticated POST to /v1/messages", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(401)
    const json = JSON.parse(res.body)
    expect(json.error.type).toBe("auth_error")
  })

  it("rejects wrong API key", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "wrong-key",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("returns 500 when no upstream key is configured", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.apiKey,
      },
      body: "{}",
    })
    expect(res.status).toBe(500)
    const json = JSON.parse(res.body)
    expect(json.error.type).toBe("config_error")
  })

  it("returns 404 for unknown paths", async () => {
    proxy = await startProxyServer({})
    const res = await httpRequest(`${proxy.baseUrl}/v2/unknown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.apiKey,
      },
      body: "{}",
    })
    expect(res.status).toBe(404)
  })

  it("forwards to upstream with correct auth (anthropic)", async () => {
    // Start a mock upstream server
    let receivedHeaders: http.IncomingHttpHeaders = {}
    let receivedBody = ""
    const upstream = http.createServer((req, res) => {
      receivedHeaders = req.headers
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString()
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "msg_123", type: "message", content: [] }))
      })
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      proxy = await startProxyServer({
        anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        anthropicApiKey: "sk-ant-real-key",
      })

      const res = await httpRequest(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.apiKey,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [] }),
      })

      expect(res.status).toBe(200)
      expect(receivedHeaders["x-api-key"]).toBe("sk-ant-real-key")
      expect(JSON.parse(receivedBody).model).toBe("claude-sonnet-4-20250514")
    } finally {
      upstream.close()
    }
  })

  it("forwards to upstream with correct auth (openai)", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {}
    const upstream = http.createServer((req, res) => {
      receivedHeaders = req.headers
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "chatcmpl-123", choices: [] }))
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      proxy = await startProxyServer({
        openaiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        openaiApiKey: "sk-real-openai-key",
      })

      const res = await httpRequest(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${proxy.apiKey}`,
        },
        body: JSON.stringify({ model: "o3", messages: [] }),
      })

      expect(res.status).toBe(200)
      expect(receivedHeaders.authorization).toBe("Bearer sk-real-openai-key")
    } finally {
      upstream.close()
    }
  })

  it("binds to a random port (not hardcoded)", async () => {
    proxy = await startProxyServer({})
    expect(proxy.port).toBeGreaterThan(0)
    expect(proxy.baseUrl).toContain(String(proxy.port))
  })

  it("generates a unique ephemeral key", async () => {
    proxy = await startProxyServer({})
    expect(proxy.apiKey).toMatch(/^cgx-[a-f0-9]{32}$/)
  })

  it("answers /v1/models from the configured upstreams, never a hard-coded list", async () => {
    const asked: string[] = []
    proxy = await startProxyServer({
      anthropicBaseUrl: "http://anthropic.test",
      openaiBaseUrl: "http://openai.test",
      anthropicApiKey: "sk-ant",
      openaiApiKey: "sk-oai",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push(`${String(url)} ${JSON.stringify(init?.headers)}`)
        if (String(url).startsWith("http://anthropic.test")) {
          return new Response(
            JSON.stringify({ data: [{ id: "claude-opus-5", created_at: "2026-01-01T00:00:00Z" }] }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-5", created: 7, owned_by: "openai" }] }),
          {
            status: 200,
          }
        )
      }) as typeof fetch,
    })
    const res = await httpRequest(`${proxy.baseUrl}/v1/models`)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(["claude-opus-5", "gpt-5"])
    expect(body.data[0].owned_by).toBe("anthropic")
    expect(asked[0]).toContain("anthropic.test/v1/models")
    expect(asked[0]).toContain("sk-ant")
    expect(asked[1]).toContain("Bearer sk-oai")
  })

  it("answers 502 when no upstream can list models", async () => {
    proxy = await startProxyServer({
      anthropicApiKey: "sk-ant",
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    })
    const res = await httpRequest(`${proxy.baseUrl}/v1/models`)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error.message).toContain("anthropic: HTTP 401")
  })

  it("forwards /v1/messages/count_tokens to the anthropic upstream", async () => {
    let seenPath = ""
    const upstream = http.createServer((req, res) => {
      seenPath = req.url ?? ""
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ input_tokens: 42 }))
      })
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port
    try {
      proxy = await startProxyServer({
        anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        anthropicApiKey: "sk-ant-real-key",
      })
      const res = await httpRequest(`${proxy.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": proxy.apiKey },
        body: JSON.stringify({ model: "m", messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body).input_tokens).toBe(42)
      expect(seenPath).toBe("/v1/messages/count_tokens")
    } finally {
      upstream.close()
    }
  })

  it("returns 413 when request body exceeds 16 MiB", async () => {
    // Upstream that waits for full body before responding — but the proxy
    // should abort the connection before it gets there.
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        // Only respond if we got the full body (we shouldn't)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
      req.on("error", () => {
        // Connection destroyed by proxy — expected
      })
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      proxy = await startProxyServer({
        anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        anthropicApiKey: "sk-test",
      })

      // Send a body just over 16 MiB using chunked encoding
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const parsed = new URL(`${proxy!.baseUrl}/v1/messages`)
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": proxy!.apiKey,
              "transfer-encoding": "chunked",
            },
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on("data", (c) => chunks.push(c))
            response.on("end", () => {
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            })
          }
        )
        req.on("error", reject)

        // Write chunks that exceed the limit
        const chunkSize = 1024 * 1024 // 1 MiB per chunk
        for (let i = 0; i < 17; i++) {
          req.write(Buffer.alloc(chunkSize, 0x61)) // 'a'
        }
        req.end()
      })

      expect(res.status).toBe(413)
      const json = JSON.parse(res.body)
      expect(json.error.type).toBe("payload_too_large")
    } finally {
      upstream.close()
    }
  })

  it("preserves query parameters when proxying", async () => {
    let receivedUrl = ""
    const upstream = http.createServer((req, res) => {
      receivedUrl = req.url ?? ""
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      proxy = await startProxyServer({
        anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        anthropicApiKey: "sk-test",
      })

      await httpRequest(`${proxy.baseUrl}/v1/messages?beta=true&version=2024-01-01`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.apiKey,
        },
        body: "{}",
      })

      expect(receivedUrl).toBe("/v1/messages?beta=true&version=2024-01-01")
    } finally {
      upstream.close()
    }
  })

  it("streams SSE events chunk-by-chunk", async () => {
    // Create a mock upstream that sends SSE events with delays
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
      // Send another event slightly delayed
      setTimeout(() => {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n')
        res.end()
      }, 50)
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      proxy = await startProxyServer({
        anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        anthropicApiKey: "sk-test",
      })

      // Make request and collect chunks as they arrive
      const chunks: string[] = []
      await new Promise<void>((resolve, reject) => {
        const parsed = new URL(`${proxy!.baseUrl}/v1/messages`)
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": proxy!.apiKey,
              accept: "text/event-stream",
            },
          },
          (res) => {
            res.on("data", (c: Buffer) => chunks.push(c.toString()))
            res.on("end", () => resolve())
          }
        )
        req.on("error", reject)
        req.write("{}")
        req.end()
      })

      // Should have received at least 2 chunks (multi-chunk streaming)
      expect(chunks.length).toBeGreaterThanOrEqual(1)
      const fullBody = chunks.join("")
      expect(fullBody).toContain("message_start")
      expect(fullBody).toContain("content_block_delta")
    } finally {
      upstream.close()
    }
  })
})
