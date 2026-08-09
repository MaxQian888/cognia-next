import { commandsFromOpencodeFiles } from "./opencode"

describe("commandsFromOpencodeFiles", () => {
  it("preserves OpenCode command metadata that Cognia understands", () => {
    expect(
      commandsFromOpencodeFiles("/opencode/commands", [
        {
          path: "/opencode/commands/test.md",
          content: "---\ndescription: Run tests\nmodel: anthropic/claude-sonnet-5\n---\nRun tests",
        },
      ])[0]
    ).toMatchObject({ name: "test", description: "Run tests", model: "anthropic/claude-sonnet-5" })
  })
})
