import packageJson from "../package.json"

type ConditionalExport = {
  "cognia-source": string
  types: string
  import: string
  require: string
}

const exportsMap = packageJson.exports as Record<string, ConditionalExport | string>

describe("plugin-sdk package exports", () => {
  it.each([".", "./manifest", "./context", "./contracts", "./api/tool"])(
    "publishes a built ESM/CJS/types surface for %s",
    (subpath) => {
      const entry = exportsMap[subpath]
      expect(typeof entry).toBe("object")
      expect((entry as ConditionalExport).types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
      expect((entry as ConditionalExport).import).toMatch(/^\.\/dist\/.*\.js$/)
      expect((entry as ConditionalExport).require).toMatch(/^\.\/dist\/.*\.cjs$/)
    }
  )

  it("does not publish a host or internal subpath", () => {
    expect(exportsMap["./host"]).toBeUndefined()
    expect(exportsMap["./internal"]).toBeUndefined()
  })

  it("uses an explicit API allowlist without wildcard or define subpaths", () => {
    expect(exportsMap["./api/*"]).toBeUndefined()
    expect(exportsMap["./define/*"]).toBeUndefined()
    expect(exportsMap["./api/not-real"]).toBeUndefined()
    expect(exportsMap["./api/native-anthropic-tool"]).toBeDefined()
  })

  it("packs only built/public artifacts", () => {
    expect(packageJson.files).toEqual(["dist", "contract", "wit", "README.md", "LICENSE"])
  })
})
