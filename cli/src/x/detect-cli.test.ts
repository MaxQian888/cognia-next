/**
 * Unit tests for `cli/src/x/detect-cli.ts`.
 */

import { detectAgentCli } from "./detect-cli"

describe("detectAgentCli", () => {
  it("uses Bun.which and Bun.spawn without starting a system which process", async () => {
    const calls: Array<{ command: string[]; options?: Record<string, unknown> }> = []
    const result = await detectAgentCli("codex", {
      bunRuntime: {
        which(name) {
          expect(name).toBe("codex")
          return "/opt/homebrew/bin/codex"
        },
        spawn(command, options) {
          calls.push({ command, options })
          return {
            exited: Promise.resolve(0),
            stdout: { text: async () => "codex-cli 0.145.0\n" },
            stderr: { text: async () => "" },
          }
        },
      },
    })

    expect(result).toEqual({
      installed: true,
      path: "/opt/homebrew/bin/codex",
      version: "0.145.0",
    })
    expect(calls).toEqual([
      {
        command: ["/opt/homebrew/bin/codex", "--version"],
        options: expect.objectContaining({
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        }),
      },
    ])
  })

  it("keeps detection successful when a Bun-native version probe exits non-zero", async () => {
    const result = await detectAgentCli("claude", {
      bunRuntime: {
        which: () => "/usr/local/bin/claude",
        spawn: () => ({
          exited: Promise.resolve(2),
          stdout: { text: async () => "" },
          stderr: { text: async () => "unsupported flag" },
        }),
      },
    })

    expect(result.installed).toBe(true)
    expect(result.version).toBeUndefined()
  })

  it("returns installed=true with path when `which` resolves", async () => {
    const result = await detectAgentCli("claude", {
      which: async () => "/usr/local/bin/claude",
    })
    expect(result.installed).toBe(true)
    expect(result.path).toBe("/usr/local/bin/claude")
    expect(result.installHint).toBeUndefined()
  })

  it("returns installed=false with installHint when `which` returns undefined", async () => {
    const result = await detectAgentCli("claude", {
      which: async () => undefined,
    })
    expect(result.installed).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.installHint).toContain("@anthropic-ai/claude-code")
  })

  it("returns correct install hint for codex", async () => {
    const result = await detectAgentCli("codex", {
      which: async () => undefined,
    })
    expect(result.installed).toBe(false)
    expect(result.installHint).toContain("@openai/codex")
  })

  it("returns installed=true for codex when found", async () => {
    const result = await detectAgentCli("codex", {
      which: async () => "/opt/homebrew/bin/codex",
    })
    expect(result.installed).toBe(true)
    expect(result.path).toBe("/opt/homebrew/bin/codex")
  })
})
