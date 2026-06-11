import { buildContextReport } from "./context-report"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { BuiltinToolsConfig } from "@/lib/claude/types"
import type { UsageInfo } from "@/lib/claude/adapter"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  model: "claude-opus-4-8",
}

/** A full BuiltinToolsConfig with only `coreFiles` enabled. */
const onlyCoreFiles = (): BuiltinToolsConfig => {
  const all = Object.fromEntries(
    Object.keys(config.builtinTools).map((k) => [k, false])
  ) as unknown as BuiltinToolsConfig
  return { ...all, coreFiles: true }
}

describe("buildContextReport", () => {
  it("reports zero occupancy when there is no usage yet", () => {
    const report = buildContextReport(undefined, config)
    expect(report).toContain("Context window — claude-opus-4-8")
    expect(report).toContain("(0%)")
    expect(report).toContain("Auto-compact at:")
    // The visual gauge bar renders with the percentage and a compaction marker.
    expect(report).toMatch(/\[▱+┊▱*\] 0%/)
  })

  it("computes occupancy from the latest turn's prompt-side tokens", () => {
    const usage: UsageInfo = {
      inputTokens: 100_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }
    const report = buildContextReport(usage, config)
    // The window math comes from the shared lib; assert the report renders the
    // used/total/percent + remaining rows for a non-empty turn.
    expect(report).toMatch(/Used:\s+\d+k \/ 1\.0M \(\d+%\)/)
    expect(report).toMatch(/Remaining:\s+\d/)
  })

  it("surfaces the cache-hit rate and a composition bar once usage lands", () => {
    const usage: UsageInfo = {
      inputTokens: 40_000,
      cacheReadInputTokens: 120_000,
      cacheCreationInputTokens: 40_000,
      outputTokens: 5_000,
    }
    const report = buildContextReport(usage, config)
    // 120k reused of 200k prompt tokens = 60%.
    expect(report).toContain("Cache hit:       60%")
    expect(report).toContain("Composition:")
    expect(report).toContain("█ reused")
    expect(report).toContain("░ fresh")
  })

  it("omits the cache/composition lines when there is no usage", () => {
    const report = buildContextReport(undefined, config)
    expect(report).not.toContain("Cache hit:")
    expect(report).not.toContain("Composition:")
  })

  it("sizes the window from the per-model override when given", () => {
    // An unknown model would size to the 200k fallback, but a 500k catalog
    // override pins the report's total — 100k used → 20%.
    const usage: UsageInfo = { inputTokens: 100_000 }
    const report = buildContextReport(usage, { ...config, model: "mystery-model" }, 500_000)
    expect(report).toMatch(/Used:\s+\d+k \/ 500k \(20%\)/)
  })

  it("ignores a non-positive override and uses the pattern table", () => {
    const report = buildContextReport(undefined, config, 0)
    expect(report).toContain("/ 1.0M")
  })

  it("falls back to 'default' when no model is set and lists enabled tools", () => {
    const report = buildContextReport(undefined, {
      ...config,
      model: undefined,
      builtinTools: onlyCoreFiles(),
    })
    expect(report).toContain("Context window — default (anthropic)")
    expect(report).toContain("Enabled tools: core file tools")
  })
})
