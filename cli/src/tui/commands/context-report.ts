/** Localized context diagnostics: telemetry and configuration are explicitly separated. */
import { computeContextWindowUsage } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"
import { DEFAULT_BUILTIN_TOOLS, type SdkContextUsage } from "@cognia/agent-config-types"
import { BUILTIN_TOOL_CATEGORIES } from "@/lib/settings/builtin-tools"
import { contextTokens, formatTokens, hasCacheTelemetry } from "../format/usage"
import { contextGauge } from "../format/status-bar"
import { backendContextWindow, backendIdentity } from "../runtime/backend-identity"
import { createCliTranslator, type CliLocale } from "../i18n"
import type { ResolvedConfig } from "../../config/schema"

const valid = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0
/** Treat paths/names as text, never as document markup. */
const literal = (value: string): string =>
  value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/([\\`*_{}[\]()#+!|>])/g, "\\$1")

export function buildContextReport(
  usage: UsageInfo | undefined,
  config: ResolvedConfig,
  windowOverride?: number,
  presetId?: string
): string {
  const t = createCliTranslator(config.locale, "cliUiContext")
  const tokens = (value?: number) =>
    valid(value)
      ? t("report.tokens", { short: formatTokens(value), raw: value })
      : t("report.unknown")
  const identity = backendIdentity(config, presetId)
  const window =
    valid(usage?.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : backendContextWindow(config, windowOverride, presetId)
  const reported = [usage?.contextTokens, usage?.contextInputTokens, usage?.inputTokens].some(valid)
  const lines = [
    t("report.title"),
    "",
    t("report.identity", {
      model: literal(identity.model ?? t("report.defaultModel")),
      provider: literal(identity.provider),
    }),
    "",
    t("report.latest"),
    "",
    t("report.latestMeaning"),
  ]
  if (reported && window) {
    const ctx = computeContextWindowUsage(usage ?? null, identity.model, window)
    lines.push(
      "",
      contextGauge(ctx.fraction * 100, 24),
      "",
      t("report.occupancy", {
        used: tokens(ctx.used),
        max: tokens(ctx.max),
        percent: Math.round(ctx.fraction * 100),
      }),
      t("report.remaining", { tokens: tokens(ctx.remaining) })
    )
  } else {
    lines.push(
      t("report.used", { tokens: reported ? tokens(contextTokens(usage)) : t("report.unknown") }),
      t("report.window", { tokens: window ? tokens(window) : t("report.unknown") })
    )
  }
  lines.push(
    t("report.input", { tokens: tokens(usage?.inputTokens) }),
    t("report.output", { tokens: tokens(usage?.outputTokens) })
  )
  if (valid(usage?.reasoningTokens))
    lines.push(t("report.reasoning", { tokens: tokens(usage.reasoningTokens) }))
  lines.push("", t("report.compaction"), "")
  if (identity.external) lines.push(t("report.externalCompact"))
  else {
    lines.push(
      t(config.autoCompact === false ? "report.compactDisabled" : "report.compactEstimate")
    )
    const threshold = Math.min(0.98, Math.max(0.5, config.autoCompactThreshold ?? 0.85))
    lines.push(
      t("report.estimatedThreshold", {
        percent: Math.round(threshold * 100),
        tokens: window ? tokens(Math.round(window * threshold)) : t("report.unknown"),
      })
    )
  }
  lines.push("", t("report.cache"), "")
  if (!hasCacheTelemetry(usage)) lines.push(t("report.cacheMissing"))
  else {
    lines.push(
      t("report.cacheRead", { tokens: tokens(usage?.cacheReadInputTokens) }),
      t("report.cacheWrite", { tokens: tokens(usage?.cacheCreationInputTokens) }),
      t("report.fresh", { tokens: tokens(usage?.contextInputTokens ?? usage?.inputTokens) })
    )
    if (valid(usage?.cacheCreation5mInputTokens))
      lines.push(t("report.cache5m", { tokens: tokens(usage.cacheCreation5mInputTokens) }))
    if (valid(usage?.cacheCreation1hInputTokens))
      lines.push(t("report.cache1h", { tokens: tokens(usage.cacheCreation1hInputTokens) }))
    lines.push(t("report.cacheMeaning"))
  }
  const configuredCategories = BUILTIN_TOOL_CATEGORIES.filter(
    (category) => config.builtinTools[category.id] ?? DEFAULT_BUILTIN_TOOLS[category.id]
  )
  lines.push(
    "",
    t("report.configuration"),
    "",
    t("report.cwd", { path: literal(config.cwd) }),
    t("report.builtinTools", {
      categories: configuredCategories.length,
      tools: configuredCategories.reduce((total, category) => total + category.tools.length, 0),
    }),
    t("report.roots", { count: config.additionalRoots?.length ?? 0 })
  )
  for (const root of config.additionalRoots ?? []) lines.push(`- ${literal(root)}`)
  lines.push(
    t("report.promptLength", { count: config.systemPrompt?.length ?? 0 }),
    t("report.skillDirs", { count: config.skillDirs?.length ?? 0 })
  )
  for (const dir of config.skillDirs ?? []) lines.push(`- ${literal(dir)}`)
  lines.push(
    t("report.skillMode", { mode: literal(config.skillLoadMode ?? "name") }),
    t("report.configuredNotLoaded")
  )
  return lines.join("\n")
}

/** SDK inventories overlap with categories; deferred entries are not added to occupancy. */
export function formatSdkContextBreakdown(sdk: SdkContextUsage, locale?: CliLocale): string {
  const t = createCliTranslator(locale, "cliUiContext")
  const tokens = (value?: number) =>
    valid(value)
      ? t("report.tokens", { short: formatTokens(value), raw: value })
      : t("report.unknown")
  const loading = (loaded?: boolean) =>
    t(loaded === true ? "sdk.loaded" : loaded === false ? "sdk.deferred" : "sdk.loadingUnknown")
  const lines = [
    t("sdk.title"),
    "",
    t("sdk.model", { model: literal(sdk.model ?? t("report.unknown")) }),
    ...(valid(sdk.totalTokens) && valid(sdk.maxTokens) && sdk.maxTokens > 0
      ? ["", contextGauge((sdk.totalTokens / sdk.maxTokens) * 100, 24), ""]
      : []),
    t("report.occupancy", {
      used: tokens(sdk.totalTokens),
      max: tokens(sdk.maxTokens),
      percent: sdk.percentage,
    }),
    t("sdk.rawMax", { tokens: tokens(sdk.rawMaxTokens) }),
    t("sdk.compactState", {
      state: t(
        sdk.isAutoCompactEnabled === true
          ? "sdk.enabled"
          : sdk.isAutoCompactEnabled === false
            ? "sdk.disabled"
            : "report.unknown"
      ),
    }),
    valid(sdk.autoCompactThreshold)
      ? t("sdk.compactThreshold", {
          percent: sdk.autoCompactThreshold * 100,
          tokens: tokens(Math.round(sdk.maxTokens * sdk.autoCompactThreshold)),
        })
      : t("sdk.compactUnknown"),
    "",
    t("sdk.overlap"),
  ]
  function list<T>(key: string, values: T[] | undefined, row: (value: T) => string) {
    lines.push("", t(`sdk.${key}`), "")
    if (values === undefined) lines.push(t("sdk.notReported"))
    else if (!values.length) lines.push(t("sdk.empty"))
    else lines.push(...values.map((value) => `- ${row(value)}`))
  }
  list(
    "categories",
    sdk.categories,
    (value) =>
      `${literal(value.name)}: ${tokens(value.tokens)}${value.isDeferred ? ` · ${t("sdk.deferred")}` : ""}`
  )
  list(
    "systemPrompt",
    sdk.systemPromptSections,
    (value) => `${literal(value.name)}: ${tokens(value.tokens)}`
  )
  list("systemTools", sdk.systemTools, (value) => `${literal(value.name)}: ${tokens(value.tokens)}`)
  list(
    "mcp",
    sdk.mcpTools,
    (value) =>
      `${literal(value.serverName)} / ${literal(value.name)}: ${tokens(value.tokens)} · ${loading(value.isLoaded)}`
  )
  list(
    "memory",
    sdk.memoryFiles,
    (value) => `${literal(value.path)} · ${literal(value.type)}: ${tokens(value.tokens)}`
  )
  list(
    "agents",
    sdk.agents,
    (value) => `${literal(value.agentType)} · ${literal(value.source)}: ${tokens(value.tokens)}`
  )
  list(
    "deferredTools",
    sdk.deferredBuiltinTools,
    (value) =>
      `${literal(value.name)}: ${tokens(value.tokens)} · ${loading(value.isLoaded)} · ${t("sdk.deferredInventory")}`
  )
  lines.push("", t("sdk.skills"), "")
  if (sdk.skills)
    lines.push(
      t("sdk.included", {
        included: sdk.skills.includedSkills,
        total: sdk.skills.totalSkills,
        tokens: tokens(sdk.skills.tokens),
      })
    )
  else lines.push(t("sdk.notReported"))
  list(
    "frontmatter",
    sdk.skills?.skillFrontmatter,
    (value) => `${literal(value.name)} · ${literal(value.source)}: ${tokens(value.tokens)}`
  )
  lines.push("", t("sdk.commands"), "")
  if (sdk.slashCommands)
    lines.push(
      t("sdk.included", {
        included: sdk.slashCommands.includedCommands,
        total: sdk.slashCommands.totalCommands,
        tokens: tokens(sdk.slashCommands.tokens),
      })
    )
  else lines.push(t("sdk.notReported"))
  return lines.join("\n")
}
