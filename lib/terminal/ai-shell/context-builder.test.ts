/**
 * Tests for the AI Shell context builder.
 */

import {
  buildAiShellContext,
  isContextPiiSafe,
  serializeContextForPiiCheck,
  MAX_RECENT_OUTPUT_LINES,
  MAX_RECENT_COMMANDS,
  MAX_LINE_LENGTH,
} from "./context-builder"
import type { TerminalCommandRecord } from "@/stores/terminal/terminal-store"

function makeRow(
  overrides?: Partial<{ cwd: string | null; shell: string; lastCommands: TerminalCommandRecord[] }>
) {
  return {
    cwd: overrides && "cwd" in overrides ? overrides.cwd : "/home/user/project",
    shell: overrides?.shell ?? "zsh",
    lastCommands: overrides?.lastCommands ?? [],
  }
}

function makeCommands(cmds: string[]): TerminalCommandRecord[] {
  return cmds.map((cmd, i) => ({
    cmd,
    exitCode: 0,
    endedAt: Date.now() - (cmds.length - i) * 1000,
  }))
}

describe("ai-shell/context-builder", () => {
  describe("buildAiShellContext", () => {
    it("builds context from a session row", () => {
      const row = makeRow({ lastCommands: makeCommands(["ls", "pwd"]) })
      const ctx = buildAiShellContext(row, "file1.ts\nfile2.ts", {
        gitBranch: "main",
        platform: "darwin",
      })

      expect(ctx.cwd).toBe("/home/user/project")
      expect(ctx.shell).toBe("zsh")
      expect(ctx.gitBranch).toBe("main")
      expect(ctx.recentOutput).toBe("file1.ts\nfile2.ts")
      expect(ctx.recentCommands).toEqual(["ls", "pwd"])
      expect(ctx.platform).toBe("darwin")
    })

    it("handles null cwd and missing git branch", () => {
      const row = makeRow({ cwd: null })
      const ctx = buildAiShellContext(row, "")

      expect(ctx.cwd).toBeNull()
      expect(ctx.gitBranch).toBeNull()
    })

    it("truncates output to MAX_RECENT_OUTPUT_LINES", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
      const ctx = buildAiShellContext(makeRow(), lines.join("\n"))

      const outputLines = ctx.recentOutput.split("\n")
      expect(outputLines).toHaveLength(MAX_RECENT_OUTPUT_LINES)
      // Should keep the LAST N lines (tail)
      expect(outputLines[0]).toBe("line 150")
      expect(outputLines[MAX_RECENT_OUTPUT_LINES - 1]).toBe("line 199")
    })

    it("truncates individual lines that exceed MAX_LINE_LENGTH", () => {
      const longLine = "x".repeat(MAX_LINE_LENGTH + 100)
      const ctx = buildAiShellContext(makeRow(), longLine)

      expect(ctx.recentOutput.length).toBe(MAX_LINE_LENGTH + 1) // +1 for "…"
      expect(ctx.recentOutput.endsWith("…")).toBe(true)
    })

    it("limits recent commands to MAX_RECENT_COMMANDS", () => {
      const cmds = Array.from({ length: 20 }, (_, i) => `cmd-${i}`)
      const row = makeRow({ lastCommands: makeCommands(cmds) })
      const ctx = buildAiShellContext(row, "")

      expect(ctx.recentCommands).toHaveLength(MAX_RECENT_COMMANDS)
      // Should be the LAST N commands
      expect(ctx.recentCommands[0]).toBe("cmd-10")
      expect(ctx.recentCommands[MAX_RECENT_COMMANDS - 1]).toBe("cmd-19")
    })

    it("filters out empty commands", () => {
      const records: TerminalCommandRecord[] = [
        { cmd: "ls", exitCode: 0, endedAt: 1000 },
        { cmd: "", exitCode: 0, endedAt: 2000 },
        { cmd: "pwd", exitCode: 0, endedAt: 3000 },
      ]
      const row = makeRow({ lastCommands: records })
      const ctx = buildAiShellContext(row, "")

      expect(ctx.recentCommands).toEqual(["ls", "pwd"])
    })

    it("handles empty output string", () => {
      const ctx = buildAiShellContext(makeRow(), "")
      expect(ctx.recentOutput).toBe("")
    })
  })

  describe("isContextPiiSafe", () => {
    it("returns true when no PII is detected", () => {
      const ctx = buildAiShellContext(makeRow(), "normal output")
      expect(isContextPiiSafe(ctx)).toBe(true)
    })

    it("returns false when custom gate rejects", () => {
      const ctx = buildAiShellContext(makeRow(), "secret text")
      const alwaysFalse = () => false
      expect(isContextPiiSafe(ctx, { isPiiSafe: alwaysFalse })).toBe(false)
    })

    it("returns true for empty sections with custom gate that rejects non-empty", () => {
      const ctx = buildAiShellContext(makeRow({ cwd: null, lastCommands: [] }), "")
      // Gate that rejects non-empty but allows empty
      const rejectNonEmpty = (text: string) => text === ""
      // cwd is null so that section is empty string, recentOutput is empty,
      // no commands — all sections are empty string
      expect(isContextPiiSafe(ctx, { isPiiSafe: rejectNonEmpty })).toBe(true)
    })

    it("checks each section independently", () => {
      const ctx = buildAiShellContext(
        makeRow({ lastCommands: makeCommands(["export API_KEY=sk-1234567890abcdef"]) }),
        "safe output"
      )
      // The real hasNoLeakingPii will catch API keys
      const gateResults = new Map<string, boolean>()
      const trackingGate = (text: string) => {
        // Simulate: reject anything with "sk-"
        const safe = !text.includes("sk-")
        gateResults.set(text, safe)
        return safe
      }
      expect(isContextPiiSafe(ctx, { isPiiSafe: trackingGate })).toBe(false)
    })
  })

  describe("serializeContextForPiiCheck", () => {
    it("serializes all non-empty sections", () => {
      const ctx = buildAiShellContext(
        makeRow({ lastCommands: makeCommands(["ls", "git status"]) }),
        "output line",
        { gitBranch: "dev", platform: "darwin" }
      )
      const text = serializeContextForPiiCheck(ctx)

      expect(text).toContain("CWD: /home/user/project")
      expect(text).toContain("Shell: zsh")
      expect(text).toContain("Branch: dev")
      expect(text).toContain("Output:\noutput line")
      expect(text).toContain("History:\nls\ngit status")
    })

    it("omits null cwd and null branch", () => {
      const ctx = buildAiShellContext(makeRow({ cwd: null }), "")
      const text = serializeContextForPiiCheck(ctx)

      expect(text).not.toContain("CWD:")
      expect(text).not.toContain("Branch:")
    })

    it("omits empty output and empty history", () => {
      const ctx = buildAiShellContext(makeRow(), "")
      const text = serializeContextForPiiCheck(ctx)

      expect(text).not.toContain("Output:")
      expect(text).not.toContain("History:")
    })
  })
})
