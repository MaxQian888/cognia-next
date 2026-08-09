import { editorLanguageFromMonacoId, languageFromPath } from "./editor-language"

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
