#!/usr/bin/env node
// Fixture language server for the managed Pro IDE's real-binary E2E.
//
// The smallest LSP server that proves the whole protocol path: it answers
// `initialize` with a hover capability and every hover with a fixed markdown
// string naming the document and position it was asked about. Self-contained on
// purpose: the proxy build copies this one file into a content-addressed cache
// and runs it there, so it may import nothing beside it.

let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8")
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        capabilities: { hoverProvider: true, textDocumentSync: 1 },
        serverInfo: { name: "cognia-fixture-lsp", version: "1.0.0" },
      },
    })
  } else if (message.method === "textDocument/hover") {
    const { textDocument, position } = message.params
    const name = textDocument.uri.split("/").pop()
    send({
      id: message.id,
      result: {
        contents: {
          kind: "markdown",
          value: `Cognia fixture hover: ${name} ${position.line}:${position.character}`,
        },
      },
    })
  } else if (message.method === "shutdown") {
    send({ id: message.id, result: null })
  } else if (message.method === "exit") {
    process.exit(0)
  } else if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: `unhandled ${message.method}` } })
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")
    buffer = buffer.subarray(headerEnd + 4 + length)
    handle(JSON.parse(body))
  }
})
