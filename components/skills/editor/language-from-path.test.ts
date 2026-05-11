import { languageFromPath } from "./language-from-path"

describe("languageFromPath", () => {
  test.each([
    ["SKILL.md", "markdown"],
    ["scripts/build.js", "typescript"],
    ["scripts/build.ts", "typescript"],
    ["scripts/build.mjs", "typescript"],
    ["scripts/run.py", "python"],
    ["scripts/run.sh", "shell"],
    ["scripts/run.bash", "shell"],
    ["data/config.json", "json"],
    ["assets/logo.png", "plaintext"],
    ["README", "plaintext"],
    ["", "plaintext"],
  ] as const)("maps %s → %s", (input, expected) => {
    expect(languageFromPath(input)).toBe(expected)
  })
})
