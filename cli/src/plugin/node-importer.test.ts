import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { definePlugin } from "@cognia/plugin-sdk"
import { registerPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import { makeNodeFrontendImporter } from "./node-importer"

describe("makeNodeFrontendImporter", () => {
  it("imports an absolute path as a file URL and returns its exports", async () => {
    const calls: string[] = []
    const fakeImport = async (spec: string) => {
      calls.push(spec)
      return { default: { ok: true } }
    }
    const importer = makeNodeFrontendImporter(fakeImport)
    const mod = await importer("/abs/path/main.js", "demo")
    expect(mod).toEqual({ default: { ok: true } })
    // pathToFileURL prepends a drive letter on Windows, so match suffix only.
    expect(calls[0]).toMatch(/^file:\/\//)
    expect(calls[0]).toMatch(/\/abs\/path\/main\.js\?v=1$/)
  })

  it("bumps the cache-bust version per plugin id on reload", async () => {
    const calls: string[] = []
    const importer = makeNodeFrontendImporter(async (s) => {
      calls.push(s)
      return {}
    })
    await importer("/abs/main.js", "demo")
    importer.bumpGeneration("demo")
    await importer("/abs/main.js", "demo")
    expect(calls[0]).toMatch(/\?v=1$/)
    expect(calls[1]).toMatch(/\?v=3$/)
  })

  it("tracks generations independently per plugin id", async () => {
    const calls: string[] = []
    const importer = makeNodeFrontendImporter(async (s) => {
      calls.push(s)
      return {}
    })
    await importer("/abs/a.js", "a")
    await importer("/abs/b.js", "b")
    expect(calls[0]).toMatch(/a\.js\?v=1$/)
    expect(calls[1]).toMatch(/b\.js\?v=1$/)
  })
})

describe("independent installed bundles", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cognia-plugin-import-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("resolves SDK externals to the host singleton outside the repository", async () => {
    const entry = join(dir, "index.cjs")
    await writeFile(
      entry,
      `module.exports = {
      definePlugin: require("@cognia/plugin-sdk").definePlugin,
      registerPluginI18n: require("@cognia/plugin-sdk/api/i18n").registerPluginI18n
    }`
    )
    const exports = await makeNodeFrontendImporter()(entry, "independent")
    expect(exports.definePlugin).toBe(definePlugin)
    expect(exports.registerPluginI18n).toBe(registerPluginI18n)
  })

  it("evaluates replaced CJS bytes on reload without Node's require cache", async () => {
    const entry = join(dir, "index.js")
    const importer = makeNodeFrontendImporter()
    await writeFile(entry, "module.exports = { version: 1 }")
    expect((await importer(entry, "reload")).version).toBe(1)
    await writeFile(entry, "module.exports = { version: 2 }")
    importer.bumpGeneration("reload")
    expect((await importer(entry, "reload")).version).toBe(2)
  })

  it("rejects private host imports and undeclared external dependencies", async () => {
    const entry = join(dir, "index.cjs")
    const importer = makeNodeFrontendImporter()
    await writeFile(entry, 'module.exports = require("@/lib/utils")')
    await expect(importer(entry, "private")).rejects.toThrow("host-private")
    await writeFile(entry, 'module.exports = require("node:fs")')
    await expect(importer(entry, "private")).rejects.toThrow("is not available to plugins")
  })
})
