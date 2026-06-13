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
