import { buildCompactEffect } from "./compact-effect"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { CommandContext } from "./types"
import type { TuiState } from "../state/types"

function ctx(provider: string, args: string): CommandContext {
  const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", provider }
  return { state: {} as TuiState, config, version: "0.0.0", args }
}

describe("buildCompactEffect", () => {
  it("emits a compact effect with no focus on the Anthropic provider", () => {
    expect(buildCompactEffect(ctx("anthropic", ""))).toEqual({ kind: "compact", focus: undefined })
  })

  it("carries trimmed focus instructions through the effect", () => {
    expect(buildCompactEffect(ctx("anthropic", "  keep the file paths  "))).toEqual({
      kind: "compact",
      focus: "keep the file paths",
    })
  })

  it("works on non-Anthropic providers too (manual compaction is path-agnostic now)", () => {
    expect(buildCompactEffect(ctx("deepseek", "focus on the API"))).toEqual({
      kind: "compact",
      focus: "focus on the API",
    })
  })
})
