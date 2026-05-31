import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLspResolver } from "./resolver.mjs"

/** Fake LspService that records calls and never spawns a process. */
function makeFakeService() {
  const calls = { start: [], didOpen: [], didChange: [], request: [], stop: [] }
  return {
    calls,
    async start(p) {
      calls.start.push(p)
      return { state: "running", key: `${p.ownerId}:${p.serverId}` }
    },
    didOpen(p) {
      calls.didOpen.push(p)
    },
    didChange(p) {
      calls.didChange.push(p)
    },
    async request(p) {
      calls.request.push(p)
      return { ok: true, method: p.method, uri: p.payload.uri }
    },
    async stop(ownerId, serverId) {
      calls.stop.push({ ownerId, serverId })
      return { removed: true }
    },
  }
}

function tsProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-resolver-"))
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}")
  const file = path.join(root, "a.ts")
  fs.writeFileSync(file, "const x: number = 1")
  return { root, file }
}

test("touchFile starts a server once and didOpens, then didChanges", async () => {
  const { root, file } = tsProject()
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: (c) => c })

  const first = await resolver.touchFile(file)
  assert.equal(first.length, 1)
  assert.equal(service.calls.start.length, 1)
  assert.equal(service.calls.didOpen.length, 1)
  assert.equal(service.calls.didChange.length, 0)
  assert.equal(service.calls.start[0].cwd, root)

  await resolver.touchFile(file, "const x: number = 2")
  assert.equal(service.calls.start.length, 1) // not restarted
  assert.equal(service.calls.didChange.length, 1)
})

test("missing binary → server skipped, no start", async () => {
  const { root, file } = tsProject()
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: () => null })
  const touched = await resolver.touchFile(file)
  assert.deepEqual(touched, [])
  assert.equal(service.calls.start.length, 0)
})

test("no matching root → skipped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-noroot-"))
  const file = path.join(root, "a.ts") // no tsconfig/package.json/jsconfig
  fs.writeFileSync(file, "")
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: (c) => c })
  assert.deepEqual(await resolver.touchFile(file), [])
})

test("ingestDiagnostics + getDiagnostics returns cached diagnostics", async () => {
  const { root, file } = tsProject()
  const service = makeFakeService()
  const resolver = createLspResolver({
    service,
    cwd: root,
    ensureCommand: (c) => c,
    diagnosticsWaitMs: 1,
  })
  const uri = pathToFileURL(file).href
  resolver.ingestDiagnostics({ uri, diagnostics: [{ message: "boom", severity: 1 }] })
  const diags = await resolver.getDiagnostics(file)
  assert.equal(diags.length, 1)
  assert.equal(diags[0].message, "boom")
})

test("request routes to service.request with the file uri", async () => {
  const { root, file } = tsProject()
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: (c) => c })
  const res = await resolver.request(file, "definition", { position: { line: 0, character: 6 } })
  assert.equal(res.method, "definition")
  assert.equal(service.calls.request.length, 1)
  assert.equal(service.calls.request[0].payload.uri, pathToFileURL(file).href)
  assert.equal(service.calls.request[0].payload.position.line, 0)
})

test("request throws when no server available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-req-"))
  const file = path.join(root, "a.ts")
  fs.writeFileSync(file, "")
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: (c) => c })
  await assert.rejects(() => resolver.request(file, "hover", {}))
})

test("dispose stops every started server", async () => {
  const { root, file } = tsProject()
  const service = makeFakeService()
  const resolver = createLspResolver({ service, cwd: root, ensureCommand: (c) => c })
  await resolver.touchFile(file)
  await resolver.dispose()
  assert.equal(service.calls.stop.length, 1)
})
