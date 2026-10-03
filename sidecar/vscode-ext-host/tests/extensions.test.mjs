import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const { ExtensionRegistry, createExtensionsNamespace } =
  await import("../dist/vscode-shim/extensions.js")

function installed(name, packageJson) {
  const dir = mkdtempSync(join(tmpdir(), `ext-${name}-`))
  if (packageJson) writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson))
  return dir
}

test("the installed extensions, looked up case-insensitively, with their package.json", async () => {
  const registry = new ExtensionRegistry()
  const changes = []
  registry.onDidChange.event(() => changes.push("changed"))
  const selfPath = installed("self", { name: "self", version: "1.0.0" })
  const otherPath = installed("other", { name: "other", contributes: { commands: [] } })
  registry.set([
    { id: "Acme.Self", extensionPath: selfPath, isActive: false },
    { id: "acme.other", extensionPath: otherPath, isActive: true },
    { id: "acme.broken", extensionPath: installed("broken"), isActive: false },
  ])
  registry.set([
    { id: "Acme.Self", extensionPath: selfPath, isActive: false },
    { id: "acme.other", extensionPath: otherPath, isActive: true },
    {
      id: "acme.broken",
      extensionPath: registry.get("acme.broken").extensionPath,
      isActive: false,
    },
  ])
  assert.deepEqual(changes, ["changed"], "an identical report fires nothing")

  const requests = []
  const connection = {
    sendRequest: async (method, params) => (requests.push([method, params]), null),
  }
  const api = createExtensionsNamespace({
    connection,
    extensionId: "acme.self",
    extensions: registry,
  })
  assert.deepEqual(
    api.all.map((extension) => extension.id),
    ["Acme.Self", "acme.other", "acme.broken"]
  )
  assert.equal(api.allAcrossExtensionHosts.length, 3)
  assert.equal(api.getExtension("vscode.git"), undefined)

  const other = api.getExtension("ACME.OTHER")
  assert.equal(other.isActive, true)
  assert.equal(other.extensionPath, otherPath)
  assert.equal(other.extensionUri.fsPath, otherPath)
  assert.equal(other.extensionKind, 2)
  assert.deepEqual(other.packageJSON, { name: "other", contributes: { commands: [] } })
  // Another extension's exports live in its own process.
  assert.equal(other.exports, undefined)
  assert.equal(await other.activate(), undefined)
  assert.deepEqual(requests, [
    ["extensions:activate", { extensionId: "acme.self", id: "acme.other" }],
  ])
  assert.deepEqual(api.getExtension("acme.broken").packageJSON, {})

  // Its own entry carries the real exports, once activated.
  const self = api.getExtension("acme.self")
  assert.equal(self.isActive, false)
  registry.setExports("acme.self", { answer: 42 })
  assert.equal(self.isActive, true)
  assert.deepEqual(self.exports, { answer: 42 })
  assert.deepEqual(await self.activate(), { answer: 42 })
  registry.clearExports("Acme.Self")
  assert.equal(self.isActive, false)
})
