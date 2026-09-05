import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const entry = fileURLToPath(new URL("./service-loader.mjs", import.meta.url))
const service = `
exports.LspService = class {
  constructor(sink) { this.sink = sink; sink("lsp:state", {}); sink("lsp:publishDiagnostics", {}) }
  async start(params) { this.command = params.command; return { state: "running" } }
  didOpen(params) { this.sink("lsp:publishDiagnostics", { uri: params.uri, diagnostics: [{ message: "type mismatch" }] }) }
  didChange() {}
  async request() { return { contents: "hover from " + this.command } }
  async stop() {}
}
`
const installer = `
exports.createLspInstaller = () => ({
  async resolveBinary() { return { status: "found", resolvedPath: "/managed/typescript-language-server" } }
})
`

// Exercise relocation with the same ESM bundling that collapses import.meta.url,
// using a temporary package rather than rebuilding shared acceptance artifacts.
async function fixture(
  t,
  { bundled = true, flat = false, serviceSource = service, installerSource = installer } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-lsp-loader-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const sidecar = path.join(root, "sidecar")
  const output = path.join(
    sidecar,
    bundled ? "claude-host.mjs" : flat ? "service-loader.mjs" : "lsp/service-loader.mjs"
  )
  await fs.mkdir(path.dirname(output), { recursive: true })
  if (bundled) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
    })
    await fs.writeFile(output, result.outputFiles[0].text)
  } else {
    const source = (await fs.readFile(entry, "utf8"))
      .replace('"./resolver.mjs"', JSON.stringify(new URL("./resolver.mjs", import.meta.url).href))
      .replace(
        '"../builtin-tools/shared/exec.mjs"',
        JSON.stringify(new URL("../builtin-tools/shared/exec.mjs", import.meta.url).href)
      )
    await fs.writeFile(output, source)
  }
  const dist = path.join(sidecar, "vscode-ext-host/dist")
  await fs.mkdir(dist, { recursive: true })
  await fs.writeFile(path.join(dist, "package.json"), '{"type":"commonjs"}')
  if (serviceSource !== null) await fs.writeFile(path.join(dist, "lsp-service.js"), serviceSource)
  if (installerSource !== null)
    await fs.writeFile(path.join(dist, "lsp-installer.js"), installerSource)
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}")
  const file = path.join(root, "index.ts")
  await fs.writeFile(file, "const answer = 42")
  const loader = await import(pathToFileURL(output).href)
  const options = {
    cwd: root,
    servers: [
      {
        id: "ts",
        languages: ["typescript"],
        extensions: [".ts"],
        command: "typescript-language-server",
        rootMarkers: ["tsconfig.json"],
      },
    ],
  }
  return { loader, options, file }
}

test("a relocated sidecar loads its adjacent LSP host and managed installer for hover", async (t) => {
  const { loader, options, file } = await fixture(t)
  const resolver = await loader.createSessionLspResolver(options)
  assert.ok(resolver, "packaged LSP host must remain available after bundling")
  t.after(() => resolver.dispose())
  assert.deepEqual(await resolver.request(file, "textDocument/hover", {}), {
    contents: "hover from /managed/typescript-language-server",
  })
})

test("source layout keeps cached host loading, custom binary resolution and pushed diagnostics", async (t) => {
  const { loader, options, file } = await fixture(t, { bundled: false })
  const [first, second] = await Promise.all([
    loader.loadLspServiceCtor(),
    loader.loadLspServiceCtor(),
  ])
  assert.equal(first, second)
  const resolver = await loader.createSessionLspResolver({
    ...options,
    ensureCommand: () => "/custom/server",
  })
  t.after(() => resolver.dispose())
  assert.deepEqual(await resolver.request(file, "textDocument/hover"), {
    contents: "hover from /custom/server",
  })
  const diagnostics = resolver.getDiagnostics(file, { waitMs: 0 })
  // Let the already-started server's asynchronous touch complete before its wait.
  await new Promise(setImmediate)
  t.mock.timers.tick(1)
  assert.deepEqual(await diagnostics, [{ message: "type mismatch" }])
})

test("a flat loader loads adjacent CommonJS installer default exports", async (t) => {
  const { loader, options, file } = await fixture(t, {
    bundled: false,
    flat: true,
    installerSource:
      installer.replace(
        "exports.createLspInstaller =",
        'module.exports = { ["createLspInstaller"]:'
      ) + "}",
  })
  const resolver = await loader.createSessionLspResolver(options)
  t.after(() => resolver.dispose())
  assert.match((await resolver.request(file, "textDocument/hover")).contents, /managed/)
})

test("a host that throws a non-Error still reports its startup cause", async (t) => {
  const { loader, options } = await fixture(t, {
    bundled: false,
    serviceSource: 'throw "unsupported host runtime"',
  })
  const warnings = []
  assert.equal(
    await loader.createSessionLspResolver({
      ...options,
      logger: { warn: (...args) => warnings.push(args) },
    }),
    null
  )
  assert.equal(warnings[0][1].err, "unsupported host runtime")
})

for (const [label, serviceSource] of [
  ["missing", null],
  ["invalid", "exports.LspService = 42"],
]) {
  test(`${label} compiled host reports unavailability without crashing the session`, async (t) => {
    const { loader, options } = await fixture(t, { bundled: false, serviceSource })
    const warnings = []
    assert.equal(
      await loader.createSessionLspResolver({
        ...options,
        logger: { warn: (...args) => warnings.push(args) },
      }),
      null
    )
    assert.match(warnings[0][0], /LSP host unavailable/)
    assert.match(
      warnings[0][1].err,
      label === "missing" ? /lsp-service.js/ : /LspService not found/
    )
  })
}

for (const [label, serviceSource] of [
  ["default constructor", service.replace("exports.LspService =", "module.exports =")],
  [
    "default object",
    service.replace("exports.LspService =", 'module.exports = { ["LspService"]:') + "}",
  ],
]) {
  test(`loads a CommonJS ${label} host`, async (t) => {
    const { loader, options, file } = await fixture(t, { bundled: false, serviceSource })
    const resolver = await loader.createSessionLspResolver(options)
    t.after(() => resolver.dispose())
    assert.match((await resolver.request(file, "textDocument/hover")).contents, /managed/)
  })
}

for (const [label, installerSource] of [
  ["missing", null],
  ["invalid", "exports.createLspInstaller = 42"],
]) {
  test(`${label} installer preserves the resolver's explicit binary fallback`, async (t) => {
    const { loader, options, file } = await fixture(t, { bundled: false, installerSource })
    options.servers[0].command = process.execPath
    const resolver = await loader.createSessionLspResolver(options)
    t.after(() => resolver.dispose())
    assert.deepEqual(await resolver.request(file, "textDocument/hover"), {
      contents: "hover from " + process.execPath,
    })
  })
}

test("installer failure is observable and does not start an unavailable server", async (t) => {
  const { loader, options, file } = await fixture(t, {
    bundled: false,
    installerSource:
      'exports.createLspInstaller = () => ({ resolveBinary: async () => ({ status: "missing", error: "registry offline", resolvedPath: null }) })',
  })
  const warnings = []
  const resolver = await loader.createSessionLspResolver({
    ...options,
    logger: { warn: (message) => warnings.push(message) },
  })
  t.after(() => resolver.dispose())
  assert.deepEqual(await resolver.touchFile(file), [])
  assert.ok(warnings.some((message) => message.includes("registry offline")))
})

test("a slow installer cannot hold the agent turn beyond its budget", async (t) => {
  const { loader, options, file } = await fixture(t, {
    bundled: false,
    installerSource:
      "exports.createLspInstaller = () => ({ resolveBinary: () => new Promise(() => {}) })",
  })
  const resolver = await loader.createSessionLspResolver(options)
  t.after(() => resolver.dispose())
  const touch = resolver.touchFile(file)
  await new Promise(setImmediate)
  t.mock.timers.tick(30_000)
  assert.deepEqual(await touch, [])
})

test("managed installation stays disabled when there is no installation directory", async (t) => {
  const { loader, options, file } = await fixture(t, {
    bundled: false,
    installerSource: `exports.createLspInstaller = () => ({ resolveBinary: async (options) => {
      if (options.allowInstall) throw new Error("unexpected installation")
      return { status: "found", resolvedPath: "/existing/server" }
    } })`,
  })
  const resolver = await loader.createSessionLspResolver({ ...options, allowInstall: true })
  t.after(() => resolver.dispose())
  assert.match((await resolver.request(file, "textDocument/hover")).contents, /existing/)
})

test("sandboxed installer rejects npm before execution when network permission is absent", async (t) => {
  const { loader, options, file } = await fixture(t, {
    bundled: false,
    installerSource: `exports.createLspInstaller = ({ runNpm }) => ({ resolveBinary: async () => {
      try { await runNpm(["install"], {}) } catch (error) {
        return { status: "missing", resolvedPath: null, error: error.message }
      }
      throw new Error("npm unexpectedly allowed")
    } })`,
  })
  const warnings = []
  const resolver = await loader.createSessionLspResolver({
    ...options,
    installDir: options.cwd,
    allowInstall: true,
    builtinProcessSandbox: { network: false, writableRoots: [options.cwd] },
    logger: { warn: (message) => warnings.push(message) },
  })
  t.after(() => resolver.dispose())
  assert.deepEqual(await resolver.touchFile(file), [])
  assert.ok(
    warnings.some((message) => message.includes("LSP installation requires network permission"))
  )
})
