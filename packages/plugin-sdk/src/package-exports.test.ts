import packageJson from "../package.json"

type ConditionalExport = {
  types: string
  import: string
  require: string
}

const exportsMap = packageJson.exports as Record<string, ConditionalExport | string>

describe("plugin-sdk package exports", () => {
  it.each([
    ".",
    "./manifest",
    "./context",
    "./contracts",
    "./events",
    "./hooks",
    "./permissions",
    "./extensions",
    "./api/tool",
    "./api/context-panel",
    "./api/editor",
    "./api/webview",
  ])("publishes a built ESM/CJS/types surface for %s", (subpath) => {
    const entry = exportsMap[subpath]
    expect(typeof entry).toBe("object")
    expect((entry as ConditionalExport).types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
    expect((entry as ConditionalExport).import).toMatch(/^\.\/dist\/.*\.js$/)
    expect((entry as ConditionalExport).require).toMatch(/^\.\/dist\/.*\.cjs$/)
    expect(entry).not.toHaveProperty("cognia-source")
  })

  it("publishes dedicated artifacts for public subpaths with runtime values", () => {
    expect((exportsMap["./events"] as ConditionalExport).import).toBe("./dist/events.js")
    expect((exportsMap["./extensions"] as ConditionalExport).import).toBe("./dist/extensions.js")
  })

  it("keeps the complete context in one canonical subpath", () => {
    expect(Object.keys(exportsMap).filter((entry) => entry.startsWith("./context"))).toEqual([
      "./context",
    ])
  })

  it("does not publish a host or internal subpath", () => {
    expect(exportsMap["./host"]).toBeUndefined()
    expect(exportsMap["./internal"]).toBeUndefined()
  })

  it("uses an explicit API allowlist without wildcard or define subpaths", () => {
    expect(exportsMap["./api/*"]).toBeUndefined()
    expect(exportsMap["./define/*"]).toBeUndefined()
    expect(exportsMap["./api/not-real"]).toBeUndefined()
    expect(exportsMap["./api/native-anthropic-tool"]).toBeDefined()
    expect(exportsMap["./api/context-panel"]).toBeDefined()
    expect(exportsMap["./api/editor"]).toBeDefined()
    expect(exportsMap["./api/webview"]).toBeDefined()
  })

  it("packs only built/public artifacts", () => {
    expect(packageJson.files).toEqual(["dist", "contract", "wit", "README.md", "LICENSE"])
  })
})
