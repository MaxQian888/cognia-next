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
    "./templates",
    "./api/tool",
    "./api/context-panel",
    "./api/editor",
    "./api/webview",
    "./api/agent-team-template",
    "./api/agent-turn",
    "./api/automation",
    "./api/browser",
    "./api/i18n",
    "./api/balance-adapter",
    "./api/character-pack",
    "./api/cli-tool",
    "./api/context-provider",
    "./api/eval",
    "./api/external-agent-adapter",
    "./api/external-agent-preset",
    "./api/host-environment",
    "./api/message-renderer",
    "./api/ocr-provider",
    "./api/scheduled-task",
    "./api/security-findings",
    "./api/sandbox",
    "./api/shared-memory-adapter",
    "./api/skill",
    "./api/slash-command",
    "./api/skill-recorder",
    "./api/subagent",
    "./api/tool-renderer",
    "./api/workflow-template",
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
    expect((exportsMap["./templates"] as ConditionalExport).import).toBe("./dist/templates.js")
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
