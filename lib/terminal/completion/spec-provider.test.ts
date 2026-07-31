import { specCompletionProvider } from "./spec-provider"
import type { TerminalCompletionContext } from "./types"

function ctx(
  input: string,
  over: Partial<TerminalCompletionContext> = {}
): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/repo",
    input,
    cursor: input.length,
    recentCommands: [],
    platform: "linux",
    projectId: null,
    ...over,
  }
}

const signal = new AbortController().signal

describe("spec completion provider", () => {
  it("completes git subcommands by prefix", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("git ch"), signal)
    const texts = out.map((s) => s.text)
    expect(texts).toContain("git checkout")
    expect(texts).toContain("git cherry-pick")
    expect(out[0]).toMatchObject({
      source: "spec",
      detail: "subcommand",
      replace: { from: 4 },
    })
  })

  it("completes flags after a subcommand", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("git commit --am"), signal)
    expect(out.map((s) => s.replace?.insert)).toContain("--amend")
    expect(out[0].detail).toBe("option")
    expect(out[0].description).toBeTruthy()
  })

  it("completes nested subcommands (git remote …)", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("git remote ad"), signal)
    expect(out.map((s) => s.replace?.insert)).toEqual(["add"])
  })

  it("skips option tokens with values while descending", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("git -C /repo sta"), signal)
    const inserts = out.map((s) => s.replace?.insert)
    expect(inserts).toContain("stash")
    expect(inserts).toContain("status")
  })

  it("offers all subcommands on a fresh argument", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("docker compose "), signal)
    expect(out.map((s) => s.replace?.insert)).toEqual(
      expect.arrayContaining(["up", "down", "logs"])
    )
  })

  it("resolves Windows-style heads (pnpm.cmd)", async () => {
    const out = await specCompletionProvider.getCompletions(
      ctx("pnpm.cmd ad", { shell: "pwsh", shellPath: "pwsh.exe", platform: "windows" }),
      signal
    )
    expect(out.map((s) => s.replace?.insert)).toContain("add")
  })

  it("returns nothing for unknown CLIs, the head word, or value positions", async () => {
    expect(await specCompletionProvider.getCompletions(ctx("unknowncli su"), signal)).toEqual([])
    expect(await specCompletionProvider.getCompletions(ctx("git"), signal)).toEqual([])
    // unknown positional ends the walk: `git checkout my-branch <cursor>`
    expect(
      await specCompletionProvider.getCompletions(ctx("git checkout my-branch x"), signal)
    ).toEqual([])
  })

  it("caps the suggestion count", async () => {
    const out = await specCompletionProvider.getCompletions(ctx("git "), signal)
    expect(out.length).toBeLessThanOrEqual(8)
  })
})
