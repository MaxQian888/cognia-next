#!/usr/bin/env node
/**
 * Minimal fake LSP server for the `test-lsp-contribution` reference plugin.
 *
 * `plugin.json` points `lspServers[0].command` here. `resolveBinaryPath`
 * anchors a relative command against the plugin install directory, so the file
 * MUST live inside the plugin — the manifest previously named this exact path
 * while the directory did not exist, and `registerPluginLspServers` swallows a
 * spawn failure with a `warn`, so the one first-party proof of the
 * `lsp-server` capability could never actually start.
 *
 * Deliberately DEPENDENCY-FREE: the sidecar's equivalent fixture imports
 * `vscode-jsonrpc/node`, which an installed plugin has no access to. LSP's
 * stdio framing is just `Content-Length: <n>\r\n\r\n<json>`, so it is hand-rolled
 * here and this file runs under a bare `node`.
 *
 * Implements enough of LSP 3.17 to exercise the client lifecycle:
 * initialize / initialized / didOpen (pushes a canned diagnostic) /
 * completion / hover / shutdown / exit. No language analysis happens.
 */

let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params })
}

function handle(message) {
  const { id, method, params } = message

  switch (method) {
    case "initialize":
      respond(id, {
        capabilities: {
          // 1 = Full sync.
          textDocumentSync: 1,
          completionProvider: { triggerCharacters: ["."] },
          hoverProvider: true,
        },
        serverInfo: { name: "echo-lsp", version: "1.0.0" },
      })
      return

    case "textDocument/didOpen":
      // Canned diagnostic so the client can assert the forwarding path.
      notify("textDocument/publishDiagnostics", {
        uri: params?.textDocument?.uri ?? "",
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: 3, // Information
            source: "echo-lsp",
            message: "echo-lsp fixture diagnostic",
          },
        ],
      })
      return

    case "textDocument/completion":
      respond(id, {
        isIncomplete: false,
        items: [{ label: "echo", kind: 1, detail: "echo-lsp fixture completion" }],
      })
      return

    case "textDocument/hover":
      respond(id, { contents: { kind: "plaintext", value: "echo-lsp fixture hover" } })
      return

    case "shutdown":
      respond(id, null)
      return

    case "exit":
      process.exit(0)
      return

    default:
      // Requests carry an id and MUST be answered; notifications must not be.
      if (id !== undefined) respond(id, null)
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      // Unrecoverable framing error — drop the header and resync.
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + length) return
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
    buffer = buffer.subarray(bodyStart + length)
    try {
      handle(JSON.parse(body))
    } catch {
      // Malformed payload — ignore and keep reading the stream.
    }
  }
})

process.stdin.on("end", () => process.exit(0))
