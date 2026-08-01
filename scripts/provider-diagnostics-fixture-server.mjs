import { createServer } from "node:http"

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

function sse(response, events, delayMs = 0) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  let index = 0
  const next = () => {
    if (index >= events.length) return response.end()
    response.write(`data: ${JSON.stringify(events[index++])}\n\n`)
    setTimeout(next, delayMs)
  }
  setTimeout(next, delayMs)
}

export async function startProviderDiagnosticsFixtureServer() {
  let cancelledRequests = 0
  const server = createServer((request, response) => {
    request.on("aborted", () => {
      cancelledRequests += 1
    })
    const url = new URL(request.url ?? "/", "http://fixture.local")
    if (url.pathname === "/v1/models" || url.pathname === "/api/tags") {
      return json(response, 200, {
        data: [{ id: "fixture-model" }],
        models: [{ name: "fixture-model" }],
      })
    }
    if (url.pathname === "/v1/responses") {
      return sse(response, [
        { type: "response.output_text.delta", delta: "diagnostic" },
        { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } },
      ])
    }
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/ollama/v1/chat/completions") {
      return sse(response, [
        { choices: [{ delta: { content: "diagnostic" } }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      ])
    }
    if (url.pathname === "/v1/messages") {
      return sse(response, [
        { type: "content_block_delta", delta: { type: "text_delta", text: "diagnostic" } },
        { type: "message_delta", usage: { output_tokens: 1 } },
      ])
    }
    if (url.pathname.includes(":streamGenerateContent")) {
      return sse(response, [{ candidates: [{ content: { parts: [{ text: "diagnostic" }] } }] }])
    }
    if (url.pathname === "/bedrock/converse-stream") {
      return sse(response, [{ contentBlockDelta: { delta: { text: "diagnostic" } } }])
    }
    if (url.pathname === "/v1/embeddings") {
      return json(response, 200, {
        data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      })
    }
    if (url.pathname === "/balance/absolute")
      return json(response, 200, { balance: 12.5, currency: "USD" })
    if (url.pathname === "/balance/credits") return json(response, 200, { credits: 20, usage: 3 })
    if (url.pathname === "/balance/window")
      return json(response, 200, { usedPct: 25, resetAt: 2_000_000_000_000 })
    if (url.pathname === "/rate-limit")
      return json(response, 429, { error: "limited" }, { "retry-after": "3" })
    if (url.pathname === "/malformed-stream") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      return response.end("data: {not-json}\n\n")
    }
    if (url.pathname === "/delayed-ttft") {
      return sse(response, [{ choices: [{ delta: { content: "delayed" } }] }], 75)
    }
    if (url.pathname === "/cancellable") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      const timer = setInterval(() => response.write('data: {"tick":true}\n\n'), 25)
      request.on("close", () => clearInterval(timer))
      return
    }
    return json(response, 404, { error: "not found" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture server did not bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    cancelledRequests: () => cancelledRequests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  }
}
