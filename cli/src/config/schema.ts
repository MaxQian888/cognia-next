/**
 * Standalone CLI configuration schema.
 *
 * The CLI is desktop-independent: it never reads the desktop's IndexedDB or OS
 * keyring. All runtime config comes from layered JSON files + env + flags, which
 * resolve into a {@link ResolvedConfig} and from there into the SAME
 * `BuildOptionsContext` the desktop feeds to `resolveSendOptions` — so the agent
 * behaves identically. See `cli/src/config/to-build-context.ts`.
 *
 * Two files back the config, both under the CLI home (`~/.cognia/` by default):
 *   - `config.json`      — non-secret settings, safe to commit/share
 *   - `credentials.json` — provider API keys only, written with 0600 perms
 *
 * A project-local `./.cognia/config.json` overlays the user file, and env vars
 * + CLI flags overlay on top of that. Credentials overlay api keys last so a
 * shared `config.json` never has to carry a secret.
 */

import { z } from "zod"
import { DEFAULT_BUILTIN_TOOLS, type BuiltinToolsConfig } from "@/lib/claude/types"

/** AI SDK protocol families the sidecar's dispatch table understands. */
export const RESOLVER_PROTOCOLS = ["openai", "anthropic", "google", "mistral", "cohere"] as const

/** SDK permission modes, mirrored from `SendOptions["permissionMode"]`. */
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const

/**
 * Reasoning-effort tiers ("thinking levels"), ascending in depth. `"off"` means
 * "leave the model at its own default" (no `effort` forwarded). `"low"`→`"max"`
 * map 1:1 to `SendOptions["effort"]` / the SDK's `output_config.effort`.
 *
 * `"ultracode"` is the top composite tier: it maps to `"xhigh"` effort AND
 * auto-enables the in-tree dynamic-workflow plugin tools (`config.pluginTools`,
 * the `workflow-ai` `wf_*` suite) — see `thinking.ts` for the effort mapping and
 * the supported-model gate, and `App.tsx`/`EffortSlider.tsx` for the coupling.
 */
export const THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * The non-off thinking levels, in slider order (`low`→`ultracode`). The effort
 * slider overlay indexes into this; `"off"` is a separate checkbox, not a tick.
 */
export const EFFORT_SLIDER_LEVELS = THINKING_LEVELS.filter(
  (l): l is Exclude<ThinkingLevel, "off"> => l !== "off"
)

/** Status-bar segment ids the footer knows how to render, in any order. */
export const STATUS_SEGMENTS = [
  "model",
  "provider",
  "mode",
  "tokens",
  "ctx",
  "cache",
  "cost",
  "cwd",
  "git",
  "thinking",
] as const
export type StatusSegment = (typeof STATUS_SEGMENTS)[number]

/** Status-bar color themes. */
export const STATUS_THEMES = ["default", "dim", "vivid", "mono"] as const
export type StatusTheme = (typeof STATUS_THEMES)[number]

/** Terminal-mascot styles — the little creature that lives above the footer and
 * reacts to the agent's state (idle / thinking / working / stopping). `clawd` is
 * the signature Cognia mascot; `cat` and `robot` are alternates. */
export const MASCOT_STYLES = ["clawd", "cat", "robot"] as const
export type MascotStyle = (typeof MASCOT_STYLES)[number]

/** Output styles ("response modes", Claude Code parity) — tune HOW the agent
 * answers by appending a style instruction to the system prompt. `default`
 * appends nothing; the rest map to a prompt in `config/output-style.ts`. */
export const OUTPUT_STYLES = ["default", "concise", "explanatory", "learning"] as const
export type OutputStyle = (typeof OUTPUT_STYLES)[number]

/** Default footer layout — preserves the pre-customization footer exactly. */
export const DEFAULT_STATUS_SEGMENTS: StatusSegment[] = [
  "model",
  "provider",
  "mode",
  "tokens",
  "ctx",
  "cost",
  "cwd",
]

export const statusBarSchema = z
  .object({
    segments: z.array(z.enum(STATUS_SEGMENTS)).optional(),
    theme: z.enum(STATUS_THEMES).optional(),
  })
  .strict()

export type StatusBarConfig = z.infer<typeof statusBarSchema>

/** Terminal-mascot config. Absent ⇒ the mascot is shown in the `clawd` style
 * (the feature is opt-out, not opt-in). `enabled: false` hides it entirely. */
export const mascotSchema = z
  .object({
    enabled: z.boolean().optional(),
    style: z.enum(MASCOT_STYLES).optional(),
  })
  .strict()

export type MascotConfig = z.infer<typeof mascotSchema>

/**
 * Transcript rendering preferences — how tool/file output is shown in the
 * transcript and the full-output pager. Every field is optional; absent values
 * fall back to {@link RENDER_DEFAULTS}, which reproduces the historic look.
 */
export const renderConfigSchema = z
  .object({
    /** Max lines of an expanded tool/file result rendered inline before the
     * tail is summarized ("… +N more lines"). */
    toolResultMaxLines: z.number().int().min(1).max(100000).optional(),
    /** When an expanded inline result exceeds this many lines, render only a
     * short preview + a "open in pager" hint instead of the whole body. */
    pagerThresholdLines: z.number().int().min(1).max(1000000).optional(),
    /** Whether tool result cells start collapsed (Claude-Code default = true). */
    collapseToolsByDefault: z.boolean().optional(),
    /** Syntax-highlight inline tool/file output (Bash/PS/file reads). */
    syntaxHighlightInline: z.boolean().optional(),
    /** Show 1-based line numbers in file/code result views. */
    fileLineNumbers: z.boolean().optional(),
    /** Start the session in verbose (expand-all) mode. */
    verboseByDefault: z.boolean().optional(),
  })
  .strict()

export type RenderConfig = z.infer<typeof renderConfigSchema>

/** Resolved render preferences with every field present. */
export type ResolvedRenderConfig = Required<RenderConfig>

/** Baseline render preferences — chosen to preserve the historic transcript. */
export const RENDER_DEFAULTS: ResolvedRenderConfig = {
  toolResultMaxLines: 40,
  pagerThresholdLines: 200,
  collapseToolsByDefault: true,
  syntaxHighlightInline: true,
  fileLineNumbers: true,
  verboseByDefault: false,
}

/** Fill missing render-pref fields with {@link RENDER_DEFAULTS}. */
export function resolveRenderConfig(render: RenderConfig | undefined): ResolvedRenderConfig {
  return { ...RENDER_DEFAULTS, ...(render ? stripUndefinedShallow(render) : {}) }
}

/** Drop `undefined`-valued keys so a sparse patch never clobbers a default. */
function stripUndefinedShallow<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

export const builtinToolsSchema: z.ZodType<Partial<BuiltinToolsConfig>> = z
  .object({
    fileExtras: z.boolean().optional(),
    coreFiles: z.boolean().optional(),
    coreFilesOnAnthropic: z.boolean().optional(),
    git: z.boolean().optional(),
    process: z.boolean().optional(),
    environment: z.boolean().optional(),
    shellAdvanced: z.boolean().optional(),
    terminalRepl: z.boolean().optional(),
    lsp: z.boolean().optional(),
  })
  .strict()

export const providerConfigSchema = z
  .object({
    /** Secret. Normally lives in credentials.json, but accepted here too. */
    apiKey: z.string().min(1).optional(),
    /**
     * Subscription / OAuth token (secret). For Anthropic this is the Claude
     * Pro/Max `CLAUDE_CODE_OAUTH_TOKEN` — `to-build-context` forwards it to the
     * native agent SDK so the CLI authenticates with a subscription instead of
     * a metered API key. Normally lives in credentials.json.
     */
    authToken: z.string().min(1).optional(),
    /** Self-hosted / proxy base URL. */
    baseURL: z.string().url().optional(),
    /**
     * AI SDK family for custom/unknown provider ids. Built-in ids
     * (anthropic/openai/google/…) derive their protocol in the sidecar, so
     * this is only required for self-hosted providers.
     */
    protocol: z.enum(RESOLVER_PROTOCOLS).optional(),
    /** Per-provider default model id. */
    model: z.string().min(1).optional(),
  })
  .strict()

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/** A declarative limits descriptor's extract spec (balance | window). */
const descriptorExtractSchema = z.union([
  z
    .object({
      kind: z.literal("balance"),
      totalPath: z.string().optional(),
      usedPath: z.string().optional(),
      remainingPath: z.string().optional(),
      unit: z.string().optional(),
      currency: z.string().optional(),
      scale: z.number().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("window"),
      windows: z.array(
        z
          .object({
            id: z.string().min(1),
            labelKey: z.string(),
            // Mirrors the canonical `WindowSpec`: a pre-computed percent OR a
            // count pair (totalPath + usedPath|remainingPath) the engine divides.
            // Optional so a Coding Plan custom source (MiniMax/Kimi-coding shape)
            // parses instead of being rejected by `.strict()`.
            usedPctPath: z.string().min(1).optional(),
            usedPctScale: z.number().optional(),
            invert: z.boolean().optional(),
            usedPath: z.string().min(1).optional(),
            totalPath: z.string().min(1).optional(),
            remainingPath: z.string().min(1).optional(),
            select: z
              .object({
                arrayPath: z.string().min(1),
                by: z.string().min(1),
                equals: z.union([z.string(), z.number()]),
              })
              .strict()
              .optional(),
            resetAtPath: z.string().optional(),
            resetUnit: z.enum(["unix", "ms", "iso", "relativeSeconds"]).optional(),
            windowSecondsPath: z.string().optional(),
          })
          .strict()
      ),
    })
    .strict(),
])

/** A self-contained user-defined custom limits source. */
const customLimitsSourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    baseUrl: z.string(),
    token: z.string(),
    request: z
      .object({
        path: z.string(),
        method: z.literal("GET").optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    extract: descriptorExtractSchema,
  })
  .strict()

/**
 * The `config.json` shape. Every field is optional — an empty file is valid and
 * resolves entirely from defaults + env + flags.
 */
export const cliConfigFileSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    systemPrompt: z.string().optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    builtinTools: builtinToolsSchema.optional(),
    providers: z.record(z.string(), providerConfigSchema).optional(),
    cwd: z.string().min(1).optional(),
    /** Expose in-tree first-party plugin tools (web-tools, …) to the agent. */
    pluginTools: z.boolean().optional(),
    /**
     * First-class web tools (web_search / web_fetch). On by default; set false
     * to withhold them. web_fetch works headless; web_search needs a search
     * provider configured (otherwise it returns a clean "no provider" error).
     */
    webTools: z.boolean().optional(),
    /** Let the agent call the Skill tool to load a skill's instructions. Default off. */
    skillTool: z.boolean().optional(),
    /** Let the agent call the SlashCommand tool to run a slash command. Default off. */
    slashCommandTool: z.boolean().optional(),
    /** Customizable footer: which segments to show, in order, and the palette. */
    statusBar: statusBarSchema.optional(),
    /** Terminal mascot (enabled + style). Absent ⇒ shown in the `clawd` style. */
    mascot: mascotSchema.optional(),
    /** Output style ("response mode"). Appends a style instruction to the system
     * prompt. Absent / `default` ⇒ no change. */
    outputStyle: z.enum(OUTPUT_STYLES).optional(),
    /** Reasoning effort ("thinking level"). Forwarded to the SDK as
     * `output_config.effort` for models that support it. Absent ⇒ model default. */
    thinkingLevel: z.enum(THINKING_LEVELS).optional(),
    /** Extra skill directories to discover SKILL.md skills from, on top of the
     * CLI's own `.cognia/skills` and the reused Claude Code / Codex / OpenCode
     * dirs. Each entry is scanned like `~/.claude/skills` (folder + flat `*.md`
     * skills). */
    skillDirs: z.array(z.string().min(1)).optional(),
    /** Extra working roots the agent may read (`/add-dir`). Unioned into the
     * SDK's `additionalDirectories` so the Read tool can fetch them without an
     * approval prompt. Applies when a session is (re)created. */
    additionalRoots: z.array(z.string().min(1)).optional(),
    /** Per-id enable/disable overrides for the product-bundled built-in hooks
     * (`lib/claude/hooks/builtin-hooks`). Maps a built-in hook id to whether it
     * runs; absent ids fall back to the hook's `defaultEnabled`. */
    builtinHookOverrides: z.record(z.string(), z.boolean()).optional(),
    /** Reuse other agents' skill dirs (Claude Code `~/.claude/skills` + project
     * `.claude/skills`, Codex `~/.agents/skills`, OpenCode `~/.opencode/skills`)
     * and `skillDirs`. Defaults to `true` (absent ⇒ on); set `false` to scan
     * only `.cognia/skills`. */
    externalSkills: z.boolean().optional(),
    /** TUI colour theme. A built-in name (`classic`/`dark`/`light`/
     * `dark-daltonized`/`light-daltonized`/`mono`), `"claude-code"` to reuse the
     * user's Claude Code theme, `"codex"` to reuse the user's Codex code-block
     * theme, or `"custom:<slug>"` for `~/.cognia/themes/<slug>.json`. Absent /
     * unknown ⇒ `classic` (the historic look). Validated leniently (any string)
     * so resolution stays the single source of truth. */
    theme: z.string().min(1).optional(),
    /** User-defined limits/usage sources for arbitrary coding-plan / relay
     * providers (mirrors the desktop `AppSettings.customLimitsSources`). Each is
     * a self-contained descriptor carrying its own baseUrl + token, surfaced in
     * the `/limits` panel alongside the configured providers. */
    customLimitsSources: z.array(customLimitsSourceSchema).optional(),
    /** Transcript rendering preferences (highlight/line-numbers/truncation).
     * Absent ⇒ {@link RENDER_DEFAULTS}. */
    render: renderConfigSchema.optional(),
    /** Keyboard binding overrides: action id → key spec (e.g. `"ctrl+o"`).
     * Absent ids fall back to the default binding table. */
    keybindings: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export type CliConfigFile = z.infer<typeof cliConfigFileSchema>

/** The `credentials.json` shape — api keys / subscription tokens by provider id. */
export const credentialsFileSchema = z
  .object({
    providers: z
      .record(
        z.string(),
        z
          .object({
            apiKey: z.string().min(1).optional(),
            authToken: z.string().min(1).optional(),
          })
          .strict()
          // At least one secret must be present for an entry to be meaningful.
          .refine((v) => Boolean(v.apiKey || v.authToken), {
            message: "provider credential needs an apiKey or authToken",
          })
      )
      .optional(),
  })
  .strict()

export type CredentialsFile = z.infer<typeof credentialsFileSchema>

/**
 * Fully-resolved, defaults-applied config. This is what the rest of the CLI
 * consumes — `provider`, `permissionMode`, `builtinTools`, `cwd`, and
 * `providers` are always present; `model`/`systemPrompt`/`allowedTools` stay
 * optional because the agent has sensible fallbacks for each.
 */
export interface ResolvedConfig {
  provider: string
  model?: string
  systemPrompt?: string
  permissionMode: (typeof PERMISSION_MODES)[number]
  allowedTools?: string[]
  builtinTools: BuiltinToolsConfig
  providers: Record<string, ProviderConfig>
  cwd: string
  /** When true, the in-tree first-party plugin tools are loaded and exposed to
   * the agent (and executed via the plugin_tool_exec round-trip). Default off. */
  pluginTools?: boolean
  /** First-class web tools (web_search / web_fetch). On unless set false. */
  webTools?: boolean
  /** Let the agent call the Skill tool to load a skill's instructions. Default off. */
  skillTool?: boolean
  /** Let the agent call the SlashCommand tool to run a slash command. Default off. */
  slashCommandTool?: boolean
  /** Customizable footer config (segments + theme). Absent = default layout. */
  statusBar?: StatusBarConfig
  /** Terminal mascot config (enabled + style). Absent = shown in `clawd` style. */
  mascot?: MascotConfig
  /** Output style ("response mode"). Absent / `default` = no system-prompt change. */
  outputStyle?: OutputStyle
  /** Reasoning effort ("thinking level"). Absent = the model's own default. */
  thinkingLevel?: ThinkingLevel
  /** Extra skill directories to discover SKILL.md skills from. Absent = none. */
  skillDirs?: string[]
  /** Extra working roots the agent may read (`/add-dir`). Absent = none. */
  additionalRoots?: string[]
  /** Per-id enable/disable overrides for the product-bundled built-in hooks.
   * Absent ids fall back to each hook's `defaultEnabled`. */
  builtinHookOverrides?: Record<string, boolean>
  /** Reuse other agents' skill dirs (Claude Code / Codex / OpenCode) +
   * `skillDirs`. Absent ⇒ on (the consumer treats `!== false` as enabled). */
  externalSkills?: boolean
  /** TUI colour theme name (built-in / `claude-code` / `codex` / `custom:<slug>`).
   * Absent ⇒ `classic`. Resolved to a palette by `tui/theme/resolve`. */
  theme?: string
  /** User-defined limits sources surfaced in `/limits`. Absent ⇒ none. */
  customLimitsSources?: import("@/types/subscription").CustomLimitsSource[]
  /** Transcript rendering preferences. Absent ⇒ {@link RENDER_DEFAULTS}. */
  render?: RenderConfig
  /** Keyboard binding overrides (action id → key spec). Absent ids ⇒ defaults. */
  keybindings?: Record<string, string>
}

/** Provider id assumed when neither config, env, nor flag names one. */
export const DEFAULT_PROVIDER = "anthropic"

/**
 * Baseline config before any file/env/flag is applied. `cwd` is intentionally
 * empty here and filled with `process.cwd()` by the loader so this constant
 * stays pure (no environment reads at module load).
 */
export const DEFAULT_RESOLVED_CONFIG: Omit<ResolvedConfig, "cwd"> = {
  provider: DEFAULT_PROVIDER,
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: {},
}
