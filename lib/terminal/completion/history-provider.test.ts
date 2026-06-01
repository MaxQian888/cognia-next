import { historyProvider } from "./history-provider"
import type { TerminalCompletionContext } from "./types"

function ctx(input: string, recent: string[]): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "zsh",
    shellPath: "/bin/zsh",
    cwd: "/x",
    input,
    cursor: input.length,
    recentCommands: recent,
    platform: "macos",
  }
}

const signal = new AbortController().signal

describe("historyProvider", () => {
  it("has a stable builtin id and label", () => {
    expect(historyProvider.id).toBe("builtin:history")
    expect(historyProvider.label.length).toBeGreaterThan(0)
  })

  it("suggests recent commands that extend the prefix, newest first", async () => {
    const out = await historyProvider.getCompletions(
      ctx("git ", ["git status", "ls", "git commit -m x", "git push"]),
      signal
    )
    expect(out[0].text).toBe("git push")
    expect(out.every((s) => s.source === "history")).toBe(true)
    expect(out.every((s) => s.text.startsWith("git "))).toBe(true)
  })

  it("dedupes repeated history entries", async () => {
    const out = await historyProvider.getCompletions(
      ctx("npm ", ["npm run dev", "npm run dev", "npm test"]),
      signal
    )
    const texts = out.map((s) => s.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it("excludes the exact input and shorter entries", async () => {
    const out = await historyProvider.getCompletions(ctx("ls", ["ls", "l"]), signal)
    expect(out).toEqual([])
  })

  it("returns nothing for blank input", async () => {
    expect(await historyProvider.getCompletions(ctx("   ", ["git status"]), signal)).toEqual([])
  })

  it("assigns descending scores so newer matches rank higher", async () => {
    const out = await historyProvider.getCompletions(
      ctx("cd ", ["cd /a", "cd /b", "cd /c"]),
      signal
    )
    expect(out[0].text).toBe("cd /c")
    expect(out[0].score).toBeGreaterThan(out[out.length - 1].score ?? 0)
  })
})
