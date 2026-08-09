/**
 * Unit tests for `cli/src/x/detect-cli.ts`.
 */

import { detectAgentCli } from "./detect-cli"

describe("detectAgentCli", () => {
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
