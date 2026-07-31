import { historyProvider } from "./history-provider"
import type { TerminalCompletionContext } from "./types"

const mockQuery = jest.fn(async (..._args: unknown[]) => [] as Array<{ command: string }>)
jest.mock("@/lib/db/terminal-history", () => ({
  queryTerminalHistory: (...args: unknown[]) => mockQuery(...args),
}))

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
    projectId: "p1",
  }
}

const signal = new AbortController().signal

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([])
})

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
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it("assigns descending scores so newer matches rank higher", async () => {
    const out = await historyProvider.getCompletions(
      ctx("cd ", ["cd /a", "cd /b", "cd /c"]),
      signal
    )
    expect(out[0].text).toBe("cd /c")
    expect(out[0].score).toBeGreaterThan(out[out.length - 1].score ?? 0)
  })

  describe("durable tier", () => {
    it("queries the durable history with project + cwd context", async () => {
      await historyProvider.getCompletions(ctx("git ", []), signal)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "git ", projectId: "p1", cwd: "/x" })
      )
    })

    it("merges durable rows behind the ring matches, deduped", async () => {
      mockQuery.mockResolvedValue([
        { command: "git push --force-with-lease" },
        { command: "git push" }, // duplicate of the ring match
        { command: "git pull --rebase" },
      ])
      const out = await historyProvider.getCompletions(ctx("git p", ["git push"]), signal)
      const texts = out.map((s) => s.text)
      expect(texts[0]).toBe("git push") // ring first
      expect(texts).toContain("git push --force-with-lease")
      expect(texts).toContain("git pull --rebase")
      expect(new Set(texts).size).toBe(texts.length)
    })

    it("drops durable rows that only match case-insensitively", async () => {
      mockQuery.mockResolvedValue([{ command: "Git Push" }])
      const out = await historyProvider.getCompletions(ctx("git p", []), signal)
      expect(out).toEqual([])
    })

    it("degrades to ring-only when the durable query rejects", async () => {
      mockQuery.mockRejectedValue(new Error("no indexeddb"))
      const out = await historyProvider.getCompletions(ctx("git ", ["git status"]), signal)
      expect(out.map((s) => s.text)).toEqual(["git status"])
    })

    it("returns [] when the signal aborts mid-query", async () => {
      const ac = new AbortController()
      mockQuery.mockImplementation(async () => {
        ac.abort()
        return [{ command: "git status" }]
      })
      const out = await historyProvider.getCompletions(ctx("git ", []), ac.signal)
      expect(out).toEqual([])
    })
  })
})
