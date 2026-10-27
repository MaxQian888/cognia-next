/** Local SSE fixture for managed-runtime tests; never contacts a model provider. */
import { createServer } from "node:http"

export async function createMockDeepSeek({
  reply = () => ({ content: "Cognia smoke completed." }),
} = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let body = ""
      for await (const chunk of request) body += chunk
      if (["/files", "/v1/files"].includes(request.url)) {
        // Exercise the provider's supported inline-image fallback.
        response.writeHead(404, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            error: { message: "Files API unavailable", type: "invalid_request_error" },
          })
        )
        return
      }
      if (!["/chat/completions", "/v1/messages"].includes(request.url))
        throw new Error(`Unexpected mock endpoint: ${request.url}`)
      const input = JSON.parse(body)
      requests.push(input)
      const index = requests.length
      const content = await reply(input, index)
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      if (request.url === "/v1/messages") {
        const send = (event) =>
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        send({
          type: "message_start",
          message: {
            id: `message-${index}`,
            type: "message",
            role: "assistant",
            model: input.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        })
        const blocks = [
          ...(content.content ? [{ type: "text", text: content.content }] : []),
          ...(content.tool_calls ?? []).map((tool) => ({
            type: "tool_use",
            id: tool.id,
            name: tool.function.name,
            input: JSON.parse(tool.function.arguments),
          })),
        ]
        for (const [blockIndex, block] of blocks.entries()) {
          send({
            type: "content_block_start",
            index: blockIndex,
            content_block:
              block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
          })
          send({
            type: "content_block_delta",
            index: blockIndex,
            delta:
              block.type === "text"
                ? { type: "text_delta", text: block.text }
                : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          })
          send({ type: "content_block_stop", index: blockIndex })
        }
        send({
          type: "message_delta",
          delta: { stop_reason: content.tool_calls ? "tool_use" : "end_turn" },
          usage: { output_tokens: 5 },
        })
        send({ type: "message_stop" })
        response.end()
        return
      }
      const frame = (delta, finish_reason = null) => ({
        id: `completion-${index}`,
        object: "chat.completion.chunk",
        created: 0,
        model: input.model,
        choices: [{ index: 0, delta, finish_reason }],
      })
      response.write(`data: ${JSON.stringify(frame(content))}\n\n`)
      response.write(
        `data: ${JSON.stringify(frame({}, content.tool_calls ? "tool_calls" : "stop"))}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
