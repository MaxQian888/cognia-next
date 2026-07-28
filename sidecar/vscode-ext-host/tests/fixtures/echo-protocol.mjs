const family = process.argv[2]
let buffer = Buffer.alloc(0)

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  if (family === "mcp") decodeLines()
  else decodeContentLength()
})

function decodeLines() {
  while (true) {
    const index = buffer.indexOf(0x0a)
    if (index < 0) return
    const line = buffer.subarray(0, index).toString("utf8").trim()
    buffer = buffer.subarray(index + 1)
    if (!line) continue
    const request = JSON.parse(line)
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echoed: request.params } })}\n`
    )
  }
}

function decodeContentLength() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
    const total = headerEnd + 4 + length
    if (buffer.length < total) return
    const request = JSON.parse(buffer.subarray(headerEnd + 4, total).toString("utf8"))
    buffer = buffer.subarray(total)
    if (request.command === "hang") continue
    const response = Buffer.from(
      JSON.stringify({
        seq: request.seq + 1,
        type: "response",
        request_seq: request.seq,
        success: true,
        command: request.command,
        body: { echoed: request.arguments },
      })
    )
    process.stdout.write(`Content-Length: ${response.length}\r\n\r\n`)
    process.stdout.write(response)
  }
}
