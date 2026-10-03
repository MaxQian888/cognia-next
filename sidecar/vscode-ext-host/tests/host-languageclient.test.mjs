// A `vscode-languageclient` extension end to end on the real built host:
// the client starts `echo-lsp.mjs`, registers its providers with the
// renderer, syncs the document the renderer opens, and answers completion
// and hover calls with what the server said, while the server's diagnostics
// reach the renderer as `languages:setDiagnostics`.
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, HOST, startHost } from "./host-harness.mjs"

const ID = "cognia.languageclient-extension"
const URI = "file:///tmp/notes.txt"
const HOST_MODULES = join(dirname(HOST), "..", "node_modules")

/**
 * The fixture as an installed, unbundled extension: its own copy of
 * `vscode-languageclient` and everything that needs, plus the server. The
 * copy matters: the host never gates its own `node_modules`, and an
 * extension's dependencies have to be attributed to the extension.
 */
function installFixture() {
  const root = mkdtempSync(join(tmpdir(), "languageclient-extension-"))
  cpSync(join(FIXTURES, "languageclient-extension"), root, { recursive: true })
  cpSync(join(FIXTURES, "echo-lsp.mjs"), join(root, "echo-lsp.mjs"))
  const pending = ["vscode-languageclient"]
  const copied = new Set()
  while (pending.length > 0) {
    const name = pending.pop()
    if (copied.has(name)) continue
    copied.add(name)
    const from = join(HOST_MODULES, name)
    cpSync(from, join(root, "node_modules", name), { recursive: true, dereference: true })
    const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"))
    pending.push(...Object.keys(manifest.dependencies ?? {}))
  }
  return root
}

const until = async (check, what) => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const found = check()
    if (found) return found
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("a languageclient extension's server answers completion and hover and reports diagnostics", async () => {
  const root = installFixture()
  const registrations = []
  const host = startHost(ID, (method, params) => {
    if (method === "languages:register") {
      registrations.push(params)
      return { token: params.token, supported: true }
    }
    return null
  })
  try {
    await host.request("extension:load", {
      extensionId: ID,
      extensionPath: root,
      main: "./extension.js",
      bundleFormat: "cjs",
      // What the client and the jsonrpc transport require to spawn the
      // server and talk to it over pipes.
      grantedModules: ["child_process", "fs", "net"],
    })
    await host.request("extension:activate", activation(ID, root))

    const registration = (kind) =>
      until(() => registrations.find((entry) => entry.kind === kind), `${kind} registration`)
    const call = async (kind, method, payload) =>
      host.request("extension:call", {
        extensionId: ID,
        token: (await registration(kind)).token,
        method,
        payload,
      })

    assert.deepEqual((await registration("hover")).selector, [
      { scheme: "file", language: "plaintext" },
    ])
    assert.deepEqual((await registration("completionItem")).triggerCharacters, ["."])

    await host.request("workspace:documentOpened", {
      uri: URI,
      languageId: "plaintext",
      version: 1,
      text: "hello world",
    })

    const diagnostics = await until(
      () => host.notifications.find((frame) => frame.method === "languages:setDiagnostics"),
      "the server's diagnostics"
    )
    assert.equal(diagnostics.params.extensionId, ID)
    assert.equal(diagnostics.params.uri, URI)
    assert.deepEqual(
      diagnostics.params.diagnostics.map(({ message, source, severity }) => ({
        message,
        source,
        severity,
      })),
      // VS Code's DiagnosticSeverity.Error is 0.
      [{ message: "echo: simulated error", source: "echo-lsp", severity: 0 }]
    )

    const completion = await call("completionItem", "provideCompletionItems", {
      uri: URI,
      version: 1,
      position: { line: 0, character: 5 },
      context: { triggerKind: 1 },
    })
    const items = Array.isArray(completion) ? completion : completion.items
    assert.deepEqual(
      items.map(({ label, insertText }) => ({ label, insertText })),
      [{ label: "echoCompletion", insertText: "echoCompletion()" }]
    )

    const hover = await call("hover", "provideHover", {
      uri: URI,
      version: 1,
      position: { line: 0, character: 2 },
    })
    assert.deepEqual(hover.contents, [{ kind: "markdown", value: "**echo** server hover" }])
    assert.deepEqual(hover.range, {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 3 },
    })
  } finally {
    host.stop()
  }
})
