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
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const

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
  "ratelimit",
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

/**
 * How enabled skills are folded into the system prompt (the context-cost lever):
 *   - `"full"` — every enabled skill's whole markdown body is appended (legacy
 *     behaviour; each skill costs its full token weight every turn).
 *   - `"name"` — only a name + description CATALOG is appended (progressive
 *     disclosure, OpenCode/Anthropic-style); the agent loads a skill's full
 *     instructions on demand via the `load_skill` tool. Keeps the prompt small
 *     even with many skills enabled. This is the default.
 */
export const SKILL_LOAD_MODES = ["name", "full"] as const
export type SkillLoadMode = (typeof SKILL_LOAD_MODES)[number]

/**
 * TUI layout model — how the screen is composed.
 *
 * `"fullscreen"` (the default) takes over the terminal's alternate screen
 * buffer and pins the banner to the top and the composer to the bottom, with a
 * dedicated scroll viewport in between (vim/htop style). `"scrollback"` keeps
 * the historic model: history is written into the terminal's native scrollback
 * via Ink's `<Static>` and only the bottom live frame is React-managed.
 *
 * The effective mode is resolved by `tui/layout-mode.resolveLayoutMode`, which
 * forces `"scrollback"` on a non-TTY / dumb terminal regardless of this value.
 */
export const LAYOUT_MODES = ["fullscreen", "scrollback"] as const
export type LayoutMode = (typeof LAYOUT_MODES)[number]

/**
 * Mouse interaction model for the fullscreen layout — a terminal-level tradeoff.
 *
 * `"scroll"` (the default) captures the wheel via SGR mouse tracking so it
 * scrolls the transcript like any pager, at the cost of native click-drag
 * selection (Shift+drag still selects in most terminals). `"select"` leaves the
 * mouse uncaptured so native click-drag text selection / copy works, at the cost
 * of wheel-scroll (PgUp/PgDn scroll the transcript instead). Only meaningful in
 * the fullscreen layout on a TTY.
 */
export const MOUSE_MODES = ["select", "scroll"] as const
export type MouseMode = (typeof MOUSE_MODES)[number]

/** Default mouse mode — wheel-scroll wins out of the box (the common expectation
 * for a fullscreen TUI); `/mouse select` trades it back for native selection. */
export const DEFAULT_MOUSE_MODE: MouseMode = "scroll"

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
    /** Reveal streamed assistant text at a gentle, word-snapped "typing" cadence
     * (smooths bursty model output). Only active on an interactive TTY; ignored
     * in CI / non-interactive output. */
    streamReveal: z.boolean().optional(),
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
  streamReveal: true,
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
     * Dev mode: discover the repo's in-tree `plugins/<id>/plugin.json` and load
     * them as live disk plugins (hot-reloadable, picked up from source). Implies
     * `pluginTools`. Only the bundled/source layout where each plugin's `main`
     * is runnable under the active loader resolves — under `cli:dev` (tsx) the
     * `@/` aliases in-tree plugins use are resolved; the packaged binary can't.
     * The directory is auto-located by walking up to the repo root, or set
     * explicitly with {@link devPluginsDir}.
     */
    devPlugins: z.boolean().optional(),
    /** Explicit directory to scan for dev plugins (`<dir>/<id>/plugin.json`).
     * Absent ⇒ auto-located repo `plugins/`. Only used when `devPlugins`. */
    devPluginsDir: z.string().min(1).optional(),
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
    /** Active agent mode id — a built-in (`general`/`plan`/`build`/`code-gen`/…)
     * or a custom mode discovered from `.cognia/modes/*.json`. Drives the mode's
     * system-prompt append, tool allow-list, model override, and (when the user
     * hasn't explicitly chosen a permission mode) permission ruleset, via the
     * shared `resolveSendOptions`. Absent ⇒ no mode (plain chat). */
    agentMode: z.string().min(1).optional(),
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
    /** How enabled skills enter the system prompt (see {@link SKILL_LOAD_MODES}).
     * `"name"` (default) injects only a name+description catalog and lets the
     * agent pull full instructions on demand via `load_skill`; `"full"` appends
     * every body verbatim. Absent ⇒ `"name"`. */
    skillLoadMode: z.enum(SKILL_LOAD_MODES).optional(),
    /** Show the one-line "Active skills (N): …" notice each time a turn loads
     * session-enabled skills. Absent ⇒ off — the `@` popup's ●/○ badges already
     * surface what is active, so the per-turn notice is opt-in. */
    showActiveSkills: z.boolean().optional(),
    /** Auto-compact the live context when it crosses {@link autoCompactThreshold}
     * of the model's window (OpenCode parity). Absent ⇒ on. */
    autoCompact: z.boolean().optional(),
    /** Fraction (0–1) of the context window at which auto-compaction fires.
     * Absent ⇒ 0.85. Clamped to [0.5, 0.98] on read. */
    autoCompactThreshold: z.number().optional(),
    /** TUI colour theme. A built-in name (`cognia`/`dark`/`light`/
     * `dark-daltonized`/`light-daltonized`/`ansi`/`mono`; legacy `classic` ⇒
     * `ansi`), `"claude-code"` to reuse the user's Claude Code theme, `"codex"`
     * to reuse the user's Codex code-block theme, or `"custom:<slug>"` for
     * `~/.cognia/themes/<slug>.json`. Absent / unknown ⇒ `cognia` (the signature
     * warm dark default). Validated leniently (any string) so resolution stays
     * the single source of truth. */
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
    /** TUI layout model. `"fullscreen"` (default) pins the banner/composer and
     * scrolls the middle in the alternate screen buffer; `"scrollback"` keeps
     * the native-scrollback `<Static>` model. Forced to `"scrollback"` on a
     * non-TTY / dumb terminal by `resolveLayoutMode`. */
    layout: z.enum(LAYOUT_MODES).optional(),
    /** Fullscreen mouse model. `"scroll"` (default) captures the wheel to scroll
     * the transcript; `"select"` keeps native click-drag text selection (losing
     * wheel-scroll). Only meaningful in the fullscreen layout on a TTY. */
    mouse: z.enum(MOUSE_MODES).optional(),
    /**
     * Idle (read) timeout for a streaming turn, in milliseconds. If the model
     * stream produces no new output for this long mid-turn — the classic
     * "connection held open but the provider stopped sending bytes" stall some
     * OpenAI-compatible relays exhibit — the turn is interrupted and fails with
     * a recoverable error (the conversation stays intact). Absent ⇒ 60000.
     * Set `0` to disable. The watchdog only arms AFTER the first streamed event
     * and pauses while a permission prompt is awaiting the user, so a slow cold
     * start or a long approval never trips it.
     */
    streamIdleTimeoutMs: z.number().int().min(0).optional(),
    /**
     * Agentic step budget for a single user turn on the non-Anthropic (ai-sdk)
     * provider channel (OpenAI-compatible relays, local engines). The sidecar
     * runs a manual agent loop and keeps streaming across tool-call legs until
     * the model naturally stops or this many steps are spent — a runaway
     * backstop, NOT a task-length limit. Absent ⇒ 256. A deliberate `maxTurns`
     * (subagents / `/goal`) overrides it. The Anthropic channel is unaffected
     * (its agent loop lives inside the Claude Agent SDK).
     */
    aiSdkMaxSteps: z.number().int().min(1).optional(),
    /**
     * Per-tool execution deadline for READ-ONLY built-in tools on the
     * non-Anthropic (ai-sdk) provider channel, in milliseconds. Read-only file
     * tools (`content_search`, `file_search`, `glob`, `grep`, `read`, the git
     * read tools, `lsp_*`, …) walk the workspace with no internal deadline, so a
     * huge / cyclic tree makes their handler hang forever — and because a tool
     * is "in flight" the stream-idle watchdog is paused, so the turn only dies
     * at the 5-minute wall-clock. This bounds each such handler and surfaces a
     * recoverable tool-error instead. Exec tools (bash / shell / process) are
     * excluded (they self-bound). Absent ⇒ 120000. Set `0` to disable.
     */
    toolExecutionTimeoutMs: z.number().int().min(0).optional(),
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
  /** Dev mode: load the repo's in-tree `plugins/<id>` as live disk plugins.
   * Implies `pluginTools`. Default off. */
  devPlugins?: boolean
  /** Explicit dev-plugins directory (`<dir>/<id>/plugin.json`). Absent ⇒
   * auto-located repo `plugins/`. Only used when `devPlugins`. */
  devPluginsDir?: string
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
  /** Active agent mode id (built-in or `.cognia/modes/*.json` custom). Absent =
   * no mode (plain chat). Resolved to an `AgentModeConfig` by `config/agent-mode`. */
  agentMode?: string
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
  /** How enabled skills enter the system prompt (see {@link SKILL_LOAD_MODES}).
   * Absent ⇒ `"name"` (name-only catalog + on-demand `load_skill`). */
  skillLoadMode?: SkillLoadMode
  /** Show the per-turn "Active skills (N): …" notice. Absent ⇒ off (the `@`
   * popup's ●/○ badges already surface active skills). */
  showActiveSkills?: boolean
  /** Auto-compact the live context near the window limit. Absent ⇒ on. */
  autoCompact?: boolean
  /** Fraction of the context window that triggers auto-compaction. Absent ⇒ 0.85. */
  autoCompactThreshold?: number
  /** TUI colour theme name (built-in / `claude-code` / `codex` / `custom:<slug>`).
   * Absent ⇒ `cognia` (the default). Resolved to a palette by `tui/theme/resolve`. */
  theme?: string
  /** User-defined limits sources surfaced in `/limits`. Absent ⇒ none. */
  customLimitsSources?: import("@/types/subscription").CustomLimitsSource[]
  /** Transcript rendering preferences. Absent ⇒ {@link RENDER_DEFAULTS}. */
  render?: RenderConfig
  /** Keyboard binding overrides (action id → key spec). Absent ids ⇒ defaults. */
  keybindings?: Record<string, string>
  /** TUI layout model (`fullscreen` / `scrollback`). Absent ⇒ `fullscreen`,
   * resolved (and capability-gated) by `tui/layout-mode.resolveLayoutMode`. */
  layout?: LayoutMode
  /** Fullscreen mouse model (`select` / `scroll`). Absent ⇒ `scroll` (wheel
   * scrolls the transcript). Only meaningful in the fullscreen layout on a TTY. */
  mouse?: MouseMode
  /** Idle (read) timeout for a streaming turn, in ms. Absent ⇒ 60000; `0`
   * disables. Guards against a provider stream that stalls mid-turn. */
  streamIdleTimeoutMs?: number
  /** Agentic step budget for a single user turn on the non-Anthropic (ai-sdk)
   * provider channel. The sidecar runs a manual agent loop and continues across
   * tool-call legs until the model stops or this budget is reached — a runaway
   * backstop, not a task-length limit. Absent ⇒ 256. A deliberate `maxTurns`
   * (subagents / `/goal`) overrides it. The Anthropic channel is unaffected (its
   * loop lives in the Agent SDK). */
  aiSdkMaxSteps?: number
  /** Per-tool execution deadline (ms) for read-only built-in tools on the
   * non-Anthropic (ai-sdk) channel — bounds a file-walk tool that would
   * otherwise hang the whole turn until the wall-clock. Exec tools self-bound
   * and are excluded. Absent ⇒ 120000; `0` disables. */
  toolExecutionTimeoutMs?: number
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
  streamIdleTimeoutMs: 60_000,
  aiSdkMaxSteps: 256,
  toolExecutionTimeoutMs: 120_000,
}
