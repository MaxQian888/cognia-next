import { defineTerminalCompletionProvider } from "./define-terminal-completion"

describe("defineTerminalCompletionProvider", () => {
  it("returns the terminal completion provider definition unchanged", () => {
    const def = {
      id: "git",
      label: "Git suggestions",
      entry: "src/terminal/git.ts",
      export: "createGitCompletionProvider",
      priority: 10,
    }

    expect(defineTerminalCompletionProvider(def)).toBe(def)
  })
})
