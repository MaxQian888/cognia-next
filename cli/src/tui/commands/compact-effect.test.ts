import { buildCompactEffect } from "./compact-effect"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { CommandContext } from "./types"
import type { TuiState } from "../state/types"

function ctx(provider: string, args: string): CommandContext {
  const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", provider }
  return { state: {} as TuiState, config, version: "0.0.0", args }
}

describe("buildCompactEffect", () => {
  it("sends the literal /compact template on the Anthropic provider", () => {
    expect(buildCompactEffect(ctx("anthropic", ""))).toEqual({ kind: "send", prompt: "/compact" })
  })

  it("appends focus instructions to the template", () => {
    expect(buildCompactEffect(ctx("anthropic", "  keep the file paths  "))).toEqual({
      kind: "send",
      prompt: "/compact keep the file paths",
    })
  })

  it("explains automatic compaction on non-Anthropic providers instead of sending a no-op", () => {
    const effect = buildCompactEffect(ctx("deepseek", "focus"))
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") expect(effect.message).toMatch(/automatically/i)
  })
})
