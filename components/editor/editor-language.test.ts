import { languageFromPath } from "./editor-language"

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
  ])("%s → %s", (path, expected) => {
    expect(languageFromPath(path)).toBe(expected)
  })

  it("falls back to plaintext for unknown or missing extensions", () => {
    expect(languageFromPath("LICENSE")).toBe("plaintext")
    expect(languageFromPath("a.xyz")).toBe("plaintext")
  })
})
