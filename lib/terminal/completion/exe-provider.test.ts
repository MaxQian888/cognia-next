import { createExeCompletionProvider } from "./exe-provider"
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

function setup(exes: string[] | (() => Promise<unknown>), desktop = true) {
  const invoke = jest.fn(typeof exes === "function" ? exes : async () => exes)
  const provider = createExeCompletionProvider({ invoke, isDesktop: () => desktop })
  return { invoke, provider }
}

describe("exe completion provider", () => {
  it("completes only the head word", async () => {
    const { invoke, provider } = setup(["gitk"])
    expect(await provider.getCompletions(ctx("git ch"), signal)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("skips empty and path-like heads", async () => {
    const { invoke, provider } = setup(["x"])
    expect(await provider.getCompletions(ctx(""), signal)).toEqual([])
    expect(await provider.getCompletions(ctx("./scr"), signal)).toEqual([])
    expect(await provider.getCompletions(ctx("~/bin/x"), signal)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("merges builtins before PATH executables, deduped case-insensitively", async () => {
    const { provider } = setup(["custom-tool", "CD"])
    const out = await provider.getCompletions(ctx("c"), signal)
    const texts = out.map((s) => s.text)
    // "cd" (builtin) present with builtin casing; "CD" from PATH deduped away.
    expect(texts).toContain("cd")
    expect(texts).not.toContain("CD")
    expect(texts).toContain("custom-tool")
    expect(texts.indexOf("cd")).toBeLessThan(texts.indexOf("custom-tool"))
  })

  it("emits replace-mode suggestions from the line start", async () => {
    const { provider } = setup(["gitk", "github-cli"])
    const out = await provider.getCompletions(ctx("git"), signal)
    expect(out.length).toBeGreaterThan(0)
    for (const s of out) {
      expect(s.source).toBe("exe")
      expect(s.replace?.from).toBe(0)
    }
    expect(out.map((s) => s.text)).toEqual(expect.arrayContaining(["gitk", "github-cli"]))
  })

  it("excludes the exact already-typed name", async () => {
    const { provider } = setup(["git", "gitk"])
    const out = await provider.getCompletions(ctx("git"), signal)
    expect(out.map((s) => s.text)).toEqual(["gitk"])
  })

  it("falls back to builtins-only off-desktop", async () => {
    const { invoke, provider } = setup(["never"], false)
    const out = await provider.getCompletions(ctx("pu", { shell: "bash" }), signal)
    expect(invoke).not.toHaveBeenCalled()
    expect(out.map((s) => s.text)).toContain("pushd")
  })

  it("degrades to builtins when the PATH scan rejects", async () => {
    const { provider } = setup(async () => {
      throw new Error("boom")
    })
    const out = await provider.getCompletions(ctx("ec"), signal)
    expect(out.map((s) => s.text)).toContain("echo")
  })

  it("matches PowerShell cmdlets case-insensitively", async () => {
    const { provider } = setup([])
    const out = await provider.getCompletions(
      ctx("get-ch", { shell: "pwsh", shellPath: "pwsh.exe", platform: "windows" }),
      signal
    )
    expect(out.map((s) => s.text)).toContain("Get-ChildItem")
  })

  it("returns [] when the signal aborts mid-flight", async () => {
    const ac = new AbortController()
    const { provider } = setup(async () => {
      ac.abort()
      return ["gitk"]
    })
    expect(await provider.getCompletions(ctx("git"), ac.signal)).toEqual([])
  })

  it("caps the suggestion count", async () => {
    const { provider } = setup(Array.from({ length: 30 }, (_, i) => `tool${i}`))
    const out = await provider.getCompletions(ctx("tool"), signal)
    expect(out.length).toBeLessThanOrEqual(8)
  })
})
