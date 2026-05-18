/**
 * Minimal fake LSP server used by `lsp-client.test.mjs`.
 *
 * Implements just enough of LSP 3.17 to exercise the CogniaLspClient
 * lifecycle: initialize, initialized, textDocument/didOpen,
 * textDocument/didChange, textDocument/completion,
 * textDocument/hover, shutdown, exit. Pushes a canned
 * textDocument/publishDiagnostics notification on every didOpen so the
 * client test can assert the diagnostic forwarding path.
 *
 * Read state is intentionally minimal — no language analysis happens.
 * The fixture exists to verify protocol semantics, not language
 * intelligence.
 */

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"

const reader = new StreamMessageReader(process.stdin)
const writer = new StreamMessageWriter(process.stdout)
const conn = createMessageConnection(reader, writer)

let initialized = false

conn.onRequest("initialize", (params) => {
  return {
    capabilities: {
      textDocumentSync: 1, // Full sync
      completionProvider: { triggerCharacters: ["."], resolveProvider: false },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      codeActionProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: ["keyword", "variable"], tokenModifiers: [] },
        full: true,
        range: true,
      },
    },
    serverInfo: { name: "echo-lsp", version: "0.0.1" },
  }
})

conn.onNotification("initialized", () => {
  initialized = true
})

conn.onNotification("textDocument/didOpen", (params) => {
  if (!initialized) return
  // Push a canned diagnostic so the test can observe the
  // `onPublishDiagnostics` callback firing.
  conn.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    diagnostics: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 1, // Error
        message: "echo: simulated error",
        source: "echo-lsp",
      },
    ],
  })
})

conn.onNotification("textDocument/didChange", () => {
  // No-op; the test doesn't need versioned tracking.
})

conn.onNotification("textDocument/didClose", () => {})

conn.onRequest("textDocument/completion", (params) => {
  return [{ label: "echoCompletion", kind: 3, insertText: "echoCompletion()" }]
})

conn.onRequest("textDocument/hover", (params) => {
  return {
    contents: { kind: "markdown", value: "**echo** server hover" },
    range: {
      start: params.position,
      end: { line: params.position.line, character: params.position.character + 1 },
    },
  }
})

conn.onRequest("textDocument/definition", () => {
  return []
})

conn.onRequest("textDocument/references", () => {
  return []
})

conn.onRequest("textDocument/formatting", () => {
  return []
})

conn.onRequest("textDocument/rangeFormatting", () => {
  return []
})

conn.onRequest("textDocument/codeAction", () => {
  return []
})

conn.onRequest("textDocument/signatureHelp", () => {
  return null
})

conn.onRequest("textDocument/documentSymbol", () => {
  return []
})

conn.onRequest("textDocument/rename", () => {
  return { changes: {} }
})

conn.onRequest("textDocument/foldingRange", () => {
  return []
})

conn.onRequest("textDocument/semanticTokens/full", () => {
  return { data: [] }
})

conn.onRequest("shutdown", () => null)

conn.onNotification("exit", () => {
  process.exit(0)
})

conn.listen()
