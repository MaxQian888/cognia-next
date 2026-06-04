import { createPathCompletionProvider, requoteToken } from "./path-provider"
import type { TerminalCompletionContext } from "./types"

function ctx(
  input: string,
  over: Partial<TerminalCompletionContext> = {}
): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "pwsh",
    shellPath: "pwsh.exe",
    cwd: "D:/repo",
    input,
    cursor: input.length,
    recentCommands: [],
    platform: "windows",
    projectId: null,
    ...over,
  }
}

const signal = new AbortController().signal

function setup(candidates: Array<{ name: string; isDir: boolean }> | (() => Promise<unknown>)) {
  const invoke = jest.fn(typeof candidates === "function" ? candidates : async () => candidates)
  const provider = createPathCompletionProvider({ invoke, isDesktop: () => true })
  return { invoke, provider }
}

describe("path completion provider", () => {
  it("returns nothing off-desktop or without a cwd", async () => {
    const invoke = jest.fn(async () => [])
    const web = createPathCompletionProvider({ invoke, isDesktop: () => false })
    expect(await web.getCompletions(ctx("cd s"), signal)).toEqual([])
    const desktop = createPathCompletionProvider({ invoke, isDesktop: () => true })
    expect(await desktop.getCompletions(ctx("cd s", { cwd: null }), signal)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("skips the head word unless it looks path-like", async () => {
    const { invoke, provider } = setup([])
    expect(await provider.getCompletions(ctx("git"), signal)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
    await provider.getCompletions(ctx("./scr"), signal)
    expect(invoke).toHaveBeenCalledWith(
      "terminal_complete_paths",
      expect.objectContaining({ fragment: "./scr" })
    )
  })

  it("requests completions for an argument token with the session cwd", async () => {
    const { invoke, provider } = setup([{ name: "src", isDir: true }])
    await provider.getCompletions(ctx("cd s"), signal)
    expect(invoke).toHaveBeenCalledWith(
      "terminal_complete_paths",
      expect.objectContaining({ cwd: "D:/repo", fragment: "s" })
    )
  })

  it("emits replace-mode suggestions spanning the whole token", async () => {
    const { provider } = setup([
      { name: "src", isDir: true },
      { name: "setup.ts", isDir: false },
    ])
    const out = await provider.getCompletions(ctx("cd s"), signal)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: "path",
      detail: "dir",
      replace: { from: 3, insert: "src\\" },
      text: "cd src\\",
    })
    expect(out[1]).toMatchObject({ detail: "file", replace: { from: 3, insert: "setup.ts" } })
    expect(out[0].score ?? 0).toBeGreaterThan(out[1].score ?? 0)
  })

  it("keeps the typed directory part and separator style", async () => {
    const { provider } = setup([{ name: "main.rs", isDir: false }])
    const out = await provider.getCompletions(ctx("cat src/ma"), signal)
    expect(out[0].replace).toEqual({ from: 4, insert: "src/main.rs" })
  })

  it("appends a POSIX separator for POSIX shells", async () => {
    const { provider } = setup([{ name: "src", isDir: true }])
    const out = await provider.getCompletions(
      ctx("cd s", { shell: "bash", shellPath: "/bin/bash", platform: "linux" }),
      signal
    )
    expect(out[0].replace?.insert).toBe("src/")
  })

  it("re-quotes spaced names for Windows-style shells (open for dirs)", async () => {
    const { provider } = setup([
      { name: "My Folder", isDir: true },
      { name: "My File.txt", isDir: false },
    ])
    const out = await provider.getCompletions(ctx("cd My"), signal)
    expect(out[0].replace?.insert).toBe('"My Folder\\')
    expect(out[1].replace?.insert).toBe('"My File.txt"')
  })

  it("backslash-escapes spaced names for POSIX shells", async () => {
    const { provider } = setup([{ name: "My Folder", isDir: true }])
    const out = await provider.getCompletions(
      ctx("cd My", { shell: "zsh", shellPath: "/bin/zsh", platform: "macos" }),
      signal
    )
    expect(out[0].replace?.insert).toBe("My\\ Folder/")
  })

  it("completes a fresh argument after trailing whitespace", async () => {
    const { invoke, provider } = setup([{ name: "src", isDir: true }])
    const out = await provider.getCompletions(ctx("cd "), signal)
    expect(invoke).toHaveBeenCalledWith(
      "terminal_complete_paths",
      expect.objectContaining({ fragment: "" })
    )
    expect(out[0].replace).toEqual({ from: 3, insert: "src\\" })
  })

  it("drops the no-op candidate equal to the typed fragment", async () => {
    const { provider } = setup([{ name: "setup.ts", isDir: false }])
    const out = await provider.getCompletions(ctx("cat setup.ts"), signal)
    expect(out).toEqual([])
  })

  it("degrades to [] when the backend rejects", async () => {
    const { provider } = setup(async () => {
      throw new Error("not a directory")
    })
    expect(await provider.getCompletions(ctx("cd s"), signal)).toEqual([])
  })

  it("returns [] when the signal aborts mid-flight", async () => {
    const ac = new AbortController()
    const { provider } = setup(async () => {
      ac.abort()
      return [{ name: "src", isDir: true }]
    })
    expect(await provider.getCompletions(ctx("cd s"), ac.signal)).toEqual([])
  })
})

describe("requoteToken", () => {
  it("passes through names without special chars", () => {
    expect(requoteToken("src/main.rs", "bash", false)).toBe("src/main.rs")
  })

  it("escapes quotes for POSIX shells", () => {
    expect(requoteToken(`a'b`, "bash", false)).toBe("a\\'b")
  })

  it("doubles inner quotes for Windows-style shells", () => {
    expect(requoteToken('a"b.txt', "pwsh", false)).toBe('"a""b.txt"')
  })
})
