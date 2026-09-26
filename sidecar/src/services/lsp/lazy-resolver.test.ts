import test from "node:test"
import assert from "node:assert/strict"
import { makeLazyLspResolver } from "./lazy-resolver.ts"

const sendOptions = { cwd: process.cwd(), lsp: { enabled: true, servers: [] } }

test("diagnostics reports an unavailable LSP host instead of claiming a clean file", async () => {
  const host = makeLazyLspResolver({ sendOptions, log: () => {} }, async () => null)
  assert.ok(host.lspResolver)
  await assert.rejects(host.lspResolver.getDiagnostics("file.ts"), /LSP host unavailable.*Rebuild/)
  await assert.rejects(
    host.lspResolver.request("file.ts", "textDocument/hover", {}),
    /LSP host unavailable/
  )
  host.dispose()
})

test("diagnostics preserves the initialized resolver cache result", async () => {
  const diagnostics = [{ message: "type mismatch" }]
  let disposed = false
  // A partial resolver: the lazy wrapper only calls what this test exercises.
  const partialResolver = async () => ({
    getDiagnostics: () => diagnostics,
    dispose: () => {
      disposed = true
    },
  })
  const host = makeLazyLspResolver(
    { sendOptions, log: () => {} },
    partialResolver as unknown as Parameters<typeof makeLazyLspResolver>[1]
  )
  assert.ok(host.lspResolver)
  assert.equal(await host.lspResolver.getDiagnostics("file.ts"), diagnostics)
  host.dispose()
  await Promise.resolve()
  assert.equal(disposed, true)
})
