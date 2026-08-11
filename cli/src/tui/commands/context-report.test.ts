import { buildContextReport, formatSdkContextBreakdown } from "./context-report"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { BuiltinToolsConfig, SdkContextUsage } from "@cognia/agent-config-types"
import type { UsageInfo } from "@/lib/claude/adapter"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  model: "claude-opus-4-8",
  // Per-provider slot mirrors the resolved config — the report now reads the
  // active model via `resolveActiveModel`, not the legacy top-level pin.
  providers: { anthropic: { model: "claude-opus-4-8" } },
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
    expect(report).toContain("Cache hit:       60% · 120k reused")
    expect(report).toContain("Cache write:     20% · 40k new")
    expect(report).toContain("Fresh input:     20% · 40k uncached")
    expect(report).toContain("Composition:")
    expect(report).toContain("█ reused")
    expect(report).toContain("░ fresh")
  })

  it("keeps multi-leg cache composition within the current context window", () => {
    const report = buildContextReport(
      {
        inputTokens: 423_000,
        contextInputTokens: 96_000,
        cacheReadInputTokens: 90_000,
        cacheCreationInputTokens: 0,
      },
      config,
      1_000_000
    )
    expect(report).toContain("Used:            186k / 1.0M (19%)")
    expect(report).toContain("Cache hit:       48% · 90k reused")
    expect(report).toContain("░ fresh 96k")
    expect(report).not.toContain("░ fresh 423k")
  })

  it("labels missing cache telemetry instead of presenting it as a zero hit rate", () => {
    const report = buildContextReport({ inputTokens: 100_000 }, config)
    expect(report).toContain("Cache telemetry: not reported by provider")
    expect(report).not.toContain("Cache hit:")
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
    const report = buildContextReport(
      usage,
      { ...config, providers: { anthropic: { model: "mystery-model" } } },
      500_000
    )
    expect(report).toMatch(/Used:\s+\d+k \/ 500k \(20%\)/)
  })

  it("ignores a non-positive override and uses the pattern table", () => {
    const report = buildContextReport(undefined, config, 0)
    expect(report).toContain("/ 1.0M")
  })

  it("never sizes the window from the built-in provider on an external agent", () => {
    // The regression: `--backend codex` reported "claude-opus-4-8 (anthropic)"
    // and a 1.0M gauge — the built-in provider's model and window — while Codex
    // was answering with its own model from `~/.codex/config.toml`.
    const report = buildContextReport(
      { inputTokens: 100_000 },
      { ...config, agentBackend: "codex" }
    )
    expect(report).toContain("Context window — default (codex)")
    expect(report).not.toContain("claude-opus-4-8")
    expect(report).toContain("Window:          unknown for this agent")
    expect(report).toContain("Used:            100k")
    // No fabricated gauge, percentage or compaction threshold.
    expect(report).not.toContain("Auto-compact at:")
    expect(report).not.toMatch(/\[▱|▰/)
  })

  it("names the external backend's own model and preset", () => {
    const report = buildContextReport(
      { inputTokens: 100_000 },
      {
        ...config,
        agentBackend: "codex",
        agentBackends: { "codex-app-server": { model: "gpt-5.2-codex" } },
      },
      400_000,
      "codex-app-server"
    )
    expect(report).toContain("Context window — gpt-5.2-codex (codex (codex-app-server))")
    // A resolved window is a real fact, so the full gauge comes back.
    expect(report).toMatch(/Used:\s+100k \/ 400k \(25%\)/)
    expect(report).toContain("Auto-compact at:")
  })

  it("falls back to 'default' when no model is set and lists enabled tools", () => {
    // "default" is only reachable for an UNKNOWN provider (a known provider
    // always resolves to its catalog default).
    const report = buildContextReport(undefined, {
      ...config,
      provider: "custom-unknown",
      model: undefined,
      providers: {},
      builtinTools: onlyCoreFiles(),
    })
    expect(report).toContain("Context window — default (custom-unknown)")
    expect(report).toContain("Enabled tools: core file tools")
  })
})

describe("formatSdkContextBreakdown", () => {
  it("renders the model, the largest categories first, and the MCP roll-up", () => {
    const out = formatSdkContextBreakdown({
      totalTokens: 42_000,
      maxTokens: 200_000,
      percentage: 21,
      model: "claude-x",
      categories: [
        { name: "System prompt", tokens: 5_000 },
        { name: "Messages", tokens: 37_000 },
        // Zero-token categories are noise and are filtered out entirely.
        { name: "Free space", tokens: 0 },
        { name: "Skills", tokens: 100, isDeferred: true },
      ],
      // A zero-token tool still counts toward the tool count.
      mcpTools: [
        { name: "search", serverName: "exa", tokens: 1_200 },
        { name: "fetch", serverName: "exa", tokens: 0 },
      ],
    })
    expect(out).toContain("Live context (SDK) — claude-x")
    expect(out.indexOf("Messages")).toBeLessThan(out.indexOf("System prompt"))
    expect(out).not.toContain("Free space")
    expect(out).toContain("Skills (deferred): 100")
    expect(out).toContain("MCP tools:       2 (1.2k)")
  })

  it("omits the model and the MCP roll-up when the SDK reports neither", () => {
    const minimal: SdkContextUsage = { totalTokens: 1_000, maxTokens: 200_000, percentage: 1 }
    const out = formatSdkContextBreakdown(minimal)
    expect(out).toContain("Live context (SDK)")
    expect(out).not.toContain("—")
    expect(out).not.toContain("MCP tools:")
  })
})
