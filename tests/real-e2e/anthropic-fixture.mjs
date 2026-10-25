import { createServer } from "node:http"

const port = Number.parseInt(process.env.PORT ?? "4010", 10)
const marker = "[web-headless-e2e] deterministic assistant reply"

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function sse(response, model) {
  const id = "msg_web_headless_e2e"
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  const event = (name, body) => {
    response.write(`event: ${name}\n`)
    response.write(`data: ${JSON.stringify(body)}\n\n`)
  }
  event("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
  event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: marker },
  })
  event("content_block_stop", { type: "content_block_stop", index: 0 })
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: marker.length },
  })
  event("message_stop", { type: "message_stop" })
  response.end()
}

const server = createServer((request, response) => {
  // Claude Code (a member's sandboxed agent, P6e) adds `?beta=true` and asks
  // for token counts and the model list; the built-in chat sends neither.
  const path = (request.url ?? "").split("?")[0]
  if (request.method === "GET" && path === "/healthz") {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === "GET" && path === "/v1/models") {
    json(response, 200, { data: [{ id: "claude-e2e", type: "model", display_name: "claude-e2e" }] })
    return
  }
  if (request.method === "POST" && path === "/v1/messages/count_tokens") {
    request.resume()
    request.on("end", () => json(response, 200, { input_tokens: 1 }))
    return
  }
  if (request.method !== "POST" || path !== "/v1/messages") {
    json(response, 404, { error: { type: "not_found", message: "not found" } })
    return
  }

  let raw = ""
  request.setEncoding("utf8")
  request.on("data", (chunk) => {
    raw += chunk
  })
  request.on("end", () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      json(response, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } })
      return
    }
    if (body.stream === true) {
      sse(response, body.model ?? "claude-e2e")
      return
    }
    json(response, 200, {
      id: "msg_web_headless_e2e",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-e2e",
      content: [{ type: "text", text: marker }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: marker.length },
    })
  })
})

server.listen(port, "0.0.0.0")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
