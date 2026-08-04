import { commandsFromCodexFiles } from "./codex"

describe("commandsFromCodexFiles", () => {
  it("converts nested Codex prompt files", () => {
    expect(
      commandsFromCodexFiles("/codex/prompts", [
        { path: "/codex/prompts/git/review.md", content: "Review $ARGUMENTS" },
      ])
    ).toEqual([
      expect.objectContaining({ source: "codex", name: "git/review", body: "Review $ARGUMENTS" }),
    ])
  })
})
