/**
 * Read a `fetch` body as Server-Sent Events.
 *
 * Yields each event's concatenated `data:` payload. Minimal SSE framing —
 * blank-line-delimited blocks, comments and other fields ignored — which is
 * everything the JSON-RPC-over-SSE agents in this repo actually send.
 *
 * Lifted out of `lib/ai/agent/external/a2a-client.ts` when the ACP client
 * needed the identical loop. The alternative was `EventSource`, and it is not
 * an alternative: it cannot set `Authorization`, the packaged shell's
 * `connect-src` blocks it, and it never sees the configured proxy. Feeding
 * this a `createPlatformStreamingFetch` body has none of those problems.
 */

const BLOCK_SEPARATOR = /(?:\r\n|\r|\n){2}/

function dataFromBlock(block: string): string {
  return block
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
}

export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>
): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = BLOCK_SEPARATOR.exec(buffer)
      while (separator) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = dataFromBlock(block)
        if (data) yield data
        separator = BLOCK_SEPARATOR.exec(buffer)
      }
    }
    // A stream that ends without a trailing blank line still carries a final
    // event; dropping it would lose the last frame of every well-behaved
    // server that closes immediately after writing.
    buffer += decoder.decode()
    const trailing = dataFromBlock(buffer)
    if (trailing) yield trailing
  } finally {
    reader.releaseLock()
  }
}
