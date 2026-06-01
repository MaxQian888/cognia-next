import { buildCompletionPrompt, ghostSuffix, sanitizeCompletion } from "./prompt"
import type { TerminalCompletionContext } from "./types"

function ctx(over: Partial<TerminalCompletionContext> = {}): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/home/me/proj",
    input: "git ",
    cursor: 4,
    recentCommands: ["git status", "ls -la"],
    platform: "linux",
    ...over,
  }
}

describe("buildCompletionPrompt", () => {
  it("includes shell, platform, cwd, recent commands, and the partial input", () => {
    const { system, prompt } = buildCompletionPrompt(ctx())
    expect(system.toLowerCase()).toContain("shell")
    expect(system).toContain("ONLY")
    expect(prompt).toContain("bash")
    expect(prompt).toContain("linux")
    expect(prompt).toContain("/home/me/proj")
    expect(prompt).toContain("git status")
    expect(prompt).toContain("git ")
  })
  it("omits the cwd line when cwd is null", () => {
    const { prompt } = buildCompletionPrompt(ctx({ cwd: null }))
    expect(prompt.toLowerCase()).not.toContain("directory:")
  })
  it("caps the recent-command context to the most recent few", () => {
    const many = Array.from({ length: 20 }, (_, i) => `cmd${i}`)
    const { prompt } = buildCompletionPrompt(ctx({ recentCommands: many }))
    expect(prompt).toContain("cmd19")
    expect(prompt).not.toContain("cmd0\n")
  })
})

describe("sanitizeCompletion", () => {
  it("returns the full line when the model echoes the prefix", () => {
    expect(sanitizeCompletion("git status", "git ")).toBe("git status")
  })
  it("strips markdown code fences", () => {
    expect(sanitizeCompletion("```sh\ngit status\n```", "git ")).toBe("git status")
  })
  it("strips wrapping backticks", () => {
    expect(sanitizeCompletion("`git status`", "git ")).toBe("git status")
  })
  it("keeps only the first non-empty line", () => {
    expect(sanitizeCompletion("git status\n# explanation", "git ")).toBe("git status")
  })
  it("treats a bare suffix as a continuation of the input", () => {
    expect(sanitizeCompletion("status", "git ")).toBe("git status")
  })
  it("returns null when there is no extra text beyond the input", () => {
    expect(sanitizeCompletion("git ", "git ")).toBeNull()
    expect(sanitizeCompletion("git", "git ")).toBeNull()
  })
  it("returns null for empty / whitespace output", () => {
    expect(sanitizeCompletion("", "git ")).toBeNull()
    expect(sanitizeCompletion("   \n  ", "git ")).toBeNull()
  })
  it("strips a leading prompt echo", () => {
    expect(sanitizeCompletion("$ git status", "git ")).toBe("git status")
  })
  it("rejects an absurdly long suggestion", () => {
    const huge = "git " + "x".repeat(1000)
    expect(sanitizeCompletion(huge, "git ")).toBeNull()
  })
})

describe("ghostSuffix", () => {
  it("returns the part of the suggestion beyond the input", () => {
    expect(ghostSuffix("git status", "git ")).toBe("status")
  })
  it("returns empty string when the suggestion does not extend the input", () => {
    expect(ghostSuffix("ls", "git ")).toBe("")
    expect(ghostSuffix("git ", "git ")).toBe("")
  })
})
