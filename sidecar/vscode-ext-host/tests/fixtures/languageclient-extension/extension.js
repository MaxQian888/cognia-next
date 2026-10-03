// The shape most language extensions take: `vscode-languageclient` starting
// a language server over stdio. The server is `echo-lsp.mjs`, which the test
// copies next to this file together with the client's own dependencies, the
// way an unbundled extension ships them.
const { LanguageClient, TransportKind } = require("vscode-languageclient/node")

let client

exports.activate = async (context) => {
  client = new LanguageClient(
    "echo",
    "Echo Language Server",
    {
      command: process.execPath,
      args: [context.asAbsolutePath("echo-lsp.mjs")],
      transport: TransportKind.stdio,
    },
    { documentSelector: [{ scheme: "file", language: "plaintext" }] }
  )
  await client.start()
}

exports.deactivate = () => client?.stop()
