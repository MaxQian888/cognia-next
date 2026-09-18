import { buildContextReport, formatSdkContextBreakdown } from "./context-report"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { SdkContextUsage } from "@cognia/agent-config-types"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  providers: { anthropic: { model: "claude-opus-4-8" } },
}

describe("buildContextReport", () => {
  it("reports unknown occupancy without prompt telemetry rather than a measured zero", () => {
    for (const usage of [undefined, {}, { outputTokens: 50 }]) {
      const report = buildContextReport(usage, config, 200000)
      expect(report).toContain("Used: not reported / unknown")
      expect(report).not.toContain("(0%)")
      expect(report).not.toContain("Remaining:")
      expect(report).not.toContain("▱")
      expect(report).toContain("Window: 200k (200000 tokens)")
    }
    expect(buildContextReport({ inputTokens: 0 }, config, 200000)).toContain(
      "Used: 0 (0 tokens) / 200k (200000 tokens) (0%)"
    )
  })

  it("uses latest context prompt metrics with output, without multi-request billing input", () => {
    const report = buildContextReport(
      {
        inputTokens: 423000,
        contextInputTokens: 96000,
        cacheReadInputTokens: 90000,
        cacheCreationInputTokens: 0,
        outputTokens: 7000,
      },
      config,
      1000000
    )
    expect(report).toContain("Used: 193k (193000 tokens) / 1.0M (1000000 tokens) (19%)")
    expect(report).toContain("Reported input (may aggregate turn requests): 423k (423000 tokens)")
    expect(report).toContain("Latest prompt fresh input: 96k (96000 tokens)")
    expect(report).toContain(
      "Reported output (shown separately; do not add again): 7.0k (7000 tokens)"
    )
    expect(report).toContain("not session totals")
    expect(report).toContain("[█████▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱] 19%")
  })

  it("prioritizes agent-reported context occupancy and window over local catalog values", () => {
    const report = buildContextReport(
      { contextTokens: 12345, contextWindow: 50000, inputTokens: 99999 },
      { ...config, agentBackend: "codex" },
      200000
    )
    expect(report).toContain("Used: 12k (12345 tokens) / 50k (50000 tokens) (25%)")
    expect(report).not.toContain("200000 tokens")
    expect(report).toContain("external agent has not reported its compaction policy")
    expect(report).not.toContain("Estimated configured threshold")
  })

  it("does not borrow the builtin model or compaction threshold for external agents", () => {
    const report = buildContextReport(
      { inputTokens: 1234 },
      {
        ...config,
        agentBackend: "codex",
        agentBackends: { "codex-app-server": { model: "native-model" } },
      },
      undefined,
      "codex-app-server"
    )
    expect(report).toContain("native-model")
    expect(report).toContain("codex")
    expect(report).not.toContain("claude-opus")
    expect(report).toContain("Window: not reported / unknown")
    expect(report).not.toContain("Estimated configured threshold")
  })

  it("distinguishes missing, zero and partial cache telemetry and TTL/output subsets", () => {
    const missing = buildContextReport({ inputTokens: 100 }, config)
    expect(missing).toContain("Cache telemetry was not reported")
    const zero = buildContextReport({ inputTokens: 100, cacheReadInputTokens: 0 }, config)
    expect(zero).toContain("Reported cache read: 0 (0 tokens)")
    expect(zero).toContain("Reported cache write: not reported / unknown")
    const full = buildContextReport(
      {
        inputTokens: 100,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheCreation5mInputTokens: 10,
        cacheCreation1hInputTokens: 20,
        outputTokens: 90,
        reasoningTokens: 15,
      },
      config
    )
    expect(full).toContain("5-minute TTL: 10 (10 tokens)")
    expect(full).toContain("1-hour TTL: 20 (20 tokens)")
    expect(full).toContain("Reasoning (subset of output, not additional): 15 (15 tokens)")
    expect(full).toContain("subdivisions of cache writes")
  })

  it("uses the configured local threshold only as an estimate and labels disabled behavior", () => {
    const report = buildContextReport(
      { inputTokens: 100 },
      { ...config, autoCompact: false, autoCompactThreshold: 0.6 },
      200000
    )
    expect(report).toContain("configured off")
    expect(report).toContain("Estimated configured threshold: 60% · 120k (120000 tokens)")
    expect(report).not.toContain("85%")
  })

  it("reports configured builtin categories without treating modifiers as tools or claiming loaded", () => {
    const builtinTools = Object.fromEntries(
      Object.keys(config.builtinTools).map((key) => [key, key === "coreFilesOnAnthropic"])
    ) as unknown as ResolvedConfig["builtinTools"]
    const report = buildContextReport(undefined, { ...config, builtinTools })
    expect(report).toContain("0 enabled categories / 0 catalog tools")
    expect(report).toContain("does not establish runtime availability or loading")
    expect(report).toContain("/tools")
  })

  it("shows safe configuration counts and paths without system prompt or credentials", () => {
    const report = buildContextReport(undefined, {
      ...config,
      locale: "zh-CN",
      systemPrompt: "secret prompt",
      providers: { anthropic: { apiKey: "secret key" } },
      additionalRoots: ["/more"],
      skillDirs: ["/skills"],
      skillLoadMode: "full",
    })
    expect(report).toContain("# 上下文报告")
    expect(report).toContain("工作目录：/work")
    expect(report).toContain("已配置的额外目录：1")
    expect(report).toContain("/more")
    expect(report).toContain("13 个字符")
    expect(report).toContain("已配置的额外 Skill 目录：1")
    expect(report).toContain("不能证明 Skill 已加载")
    expect(report).not.toContain("secret prompt")
    expect(report).not.toContain("secret key")
    expect(report).not.toContain("cliUiContext.")
  })
})

describe("formatSdkContextBreakdown", () => {
  const many = Array.from({ length: 12 }, (_, index) => index)
  const sdk: SdkContextUsage = {
    model: "live-model",
    totalTokens: 12345,
    maxTokens: 200000,
    rawMaxTokens: 250000,
    percentage: 6.1725,
    autoCompactThreshold: 0.73,
    isAutoCompactEnabled: false,
    categories: many.map((index) => ({
      name: `category-${index}`,
      tokens: index,
      isDeferred: index === 2,
      color: "blue",
    })),
    systemPromptSections: many.map((index) => ({ name: `section-${index}`, tokens: index })),
    systemTools: many.map((index) => ({ name: `system-${index}`, tokens: index })),
    mcpTools: many.map((index) => ({
      name: `mcp-${index}`,
      serverName: "server",
      tokens: index,
      ...(index === 0 ? { isLoaded: true } : index === 1 ? { isLoaded: false } : {}),
    })),
    memoryFiles: many.map((index) => ({
      path: `/memory-${index}`,
      type: "project",
      tokens: index,
    })),
    agents: many.map((index) => ({
      agentType: `agent-${index}`,
      source: "project",
      tokens: index,
    })),
    deferredBuiltinTools: many.map((index) => ({
      name: `deferred-${index}`,
      tokens: index,
      isLoaded: false,
    })),
    skills: {
      totalSkills: 50,
      includedSkills: 12,
      tokens: 1234,
      skillFrontmatter: many.map((index) => ({
        name: `skill-${index}`,
        source: "user",
        tokens: index,
      })),
    },
    slashCommands: { totalCommands: 30, includedCommands: 2, tokens: 500 },
  }

  it("renders every detail row beyond eight, preserving zero rows and original order", () => {
    const before = JSON.stringify(sdk)
    const out = formatSdkContextBreakdown(sdk)
    for (const prefix of [
      "category",
      "section",
      "system",
      "mcp",
      "memory",
      "agent",
      "deferred",
      "skill",
    ])
      expect(out).toContain(`${prefix}-11`)
    expect(out).toContain("category-0: 0 (0 tokens)")
    expect(out.indexOf("category-0")).toBeLessThan(out.indexOf("category-11"))
    expect(out).not.toContain("display color")
    expect(JSON.stringify(sdk)).toBe(before)
  })

  it("preserves SDK raw maximum, exact usage, live disabled policy and explicit threshold", () => {
    const out = formatSdkContextBreakdown(sdk)
    expect(out).toContain("12345 tokens")
    expect(out).toContain("▱] 6%")
    expect(out).toContain("Raw maximum window: 250k (250000 tokens)")
    expect(out).toContain("Live auto-compaction: disabled")
    expect(out).toContain("Reported compaction threshold: 73% · 146k (146000 tokens)")
    expect(out).toContain("Included: 12 / configured total: 50 · 1.2k (1234 tokens)")
    expect(out).toContain("Included: 2 / configured total: 30 · 500 (500 tokens)")
  })

  it("distinguishes loaded, deferred and unknown MCP state without adding overlapping inventories", () => {
    const out = formatSdkContextBreakdown(sdk)
    expect(out).toContain("server / mcp-0: 0 (0 tokens) · loaded")
    expect(out).toContain("server / mcp-1: 1 (1 tokens) · deferred / not occupying context")
    expect(out).toContain("server / mcp-2: 2 (2 tokens) · loading state unknown")
    expect(out).toContain("Do not add their subtotals together")
    expect(out).toContain("deferred inventory; do not add to occupancy")
  })

  it("differentiates missing fields from SDK-reported empty lists and avoids guessed policy", () => {
    const out = formatSdkContextBreakdown({
      totalTokens: 0,
      maxTokens: 200000,
      percentage: 0,
      categories: [],
    })
    expect(out).toContain("SDK reported an empty list")
    expect(out).toContain("Not reported by SDK")
    expect(out).toContain("Live auto-compaction: not reported / unknown")
    expect(out).toContain("Live compaction threshold: not reported / unknown")
    expect(out).not.toContain("85%")
  })

  it("localizes all document headings and retains technical paths and names", () => {
    const out = formatSdkContextBreakdown(sdk, "zh-CN")
    for (const label of [
      "SDK 实时上下文",
      "系统提示词分段",
      "系统工具",
      "MCP 工具",
      "记忆文件",
      "Skill 元信息",
      "斜杠命令",
      "加载状态未知",
    ])
      expect(out).toContain(label)
    expect(out).toContain("/memory-11")
    expect(out).toContain("live-model")
    expect(out).not.toContain("cliUiContext.")
  })
})
