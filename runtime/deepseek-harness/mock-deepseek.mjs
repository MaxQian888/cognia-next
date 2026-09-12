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
      if (request.url === "/files") {
        // Exercise the provider's supported inline-image fallback.
        response.writeHead(404, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            error: { message: "Files API unavailable", type: "invalid_request_error" },
          })
        )
        return
      }
      if (request.url !== "/chat/completions")
        throw new Error(`Unexpected mock endpoint: ${request.url}`)
      const input = JSON.parse(body)
      requests.push(input)
      const index = requests.length
      const content = await reply(input, index)
      response.writeHead(200, { "Content-Type": "text/event-stream" })
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
