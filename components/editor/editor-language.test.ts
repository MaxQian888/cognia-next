import {
  editorLanguageFromMonacoId,
  languageFromPath,
  monacoLanguageFromPath,
} from "./editor-language"

describe("languageFromPath", () => {
  it.each([
    ["SKILL.md", "markdown"],
    ["scripts/run.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["b.mjs", "typescript"],
    ["tool.py", "python"],
    ["setup.sh", "shell"],
    ["conf.json", "json"],
    ["data.JSONC", "json"],
    ["agents/openai.yaml", "yaml"],
    ["config.yml", "yaml"],
  ])("%s → %s", (path, expected) => {
    expect(languageFromPath(path)).toBe(expected)
  })

  it("falls back to plaintext for unknown or missing extensions", () => {
    expect(languageFromPath("LICENSE")).toBe("plaintext")
    expect(languageFromPath("a.xyz")).toBe("plaintext")
  })
})

describe("editorLanguageFromMonacoId", () => {
  it.each([
    ["markdown", "markdown"],
    ["javascript", "typescript"],
    ["typescriptreact", "typescript"],
    ["python", "python"],
    ["shellscript", "shell"],
    ["JSON", "json"],
    ["YAML", "yaml"],
  ])("%s → %s", (id, expected) => {
    expect(editorLanguageFromMonacoId(id)).toBe(expected)
  })

  it("degrades unknown / empty ids to plaintext", () => {
    expect(editorLanguageFromMonacoId("html")).toBe("plaintext")
    expect(editorLanguageFromMonacoId(undefined)).toBe("plaintext")
    expect(editorLanguageFromMonacoId(null)).toBe("plaintext")
  })
})

describe("monacoLanguageFromPath", () => {
  it.each([
    // Extensions the closed EditorLanguage union collapses keep their real ids.
    ["main.rs", "rust"],
    ["cmd/main.go", "go"],
    ["page.html", "html"],
    ["App.vue", "html"],
    ["Widget.svelte", "html"],
    ["styles.scss", "scss"],
    ["Main.kt", "kotlin"],
    ["lib.mm", "objective-c"],
    ["main.tf", "hcl"],
    ["query.graphql", "graphql"],
    ["schema.proto", "protobuf"],
    ["script.ps1", "powershell"],
    // Union languages resolve identically on both maps.
    ["notes.md", "markdown"],
    ["run.ts", "typescript"],
    ["conf.yaml", "yaml"],
    // `.jsonc` shares the registered `json` grammar — monaco-editor ships no
    // `jsonc` language id.
    ["config.jsonc", "json"],
    // Aliases the CM table doesn't have.
    ["a.mts", "typescript"],
    ["b.jsx", "javascript"],
    ["guide.mdx", "mdx"],
    ["compose.Dockerfile", "dockerfile"],
    ["tfvars.tfvars", "hcl"],
  ])("%s → %s", (path, expected) => {
    expect(monacoLanguageFromPath(path)).toBe(expected)
  })

  it.each([
    // Dotfile names whose "extension" is not a language.
    [".env", "ini"],
    [".env.local", "ini"],
    [".env.production", "ini"],
    [".gitignore", "ini"],
    [".eslintrc", "json"],
    // monaco-editor registers only `json` — the standalone `jsonc` id would
    // land on a language nobody owns and render as plaintext.
    ["tsconfig.json", "json"],
    ["jsconfig.json", "json"],
    ["go.mod", "go"],
    // Extension slot carries a build target, not a language.
    ["Dockerfile", "dockerfile"],
    ["Dockerfile.dev", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["Containerfile.prod", "dockerfile"],
  ])("name-table %s → %s", (path, expected) => {
    expect(monacoLanguageFromPath(path)).toBe(expected)
  })

  it("falls back to plaintext for extensionless and unknown files", () => {
    expect(monacoLanguageFromPath("LICENSE")).toBe("plaintext")
    expect(monacoLanguageFromPath("a.xyz")).toBe("plaintext")
  })

  it("honours Windows separators and lowercases the name", () => {
    expect(monacoLanguageFromPath("C:\\src\\MAIN.RS")).toBe("rust")
    expect(monacoLanguageFromPath("dir\\SUB\\Go.MOD")).toBe("go")
  })
})
