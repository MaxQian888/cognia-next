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
import { DEFAULT_BUILTIN_TOOLS, type BuiltinToolsConfig } from "@cognia/agent-config-types"

import { EFFORT_SLIDER_LEVELS, THINKING_LEVELS, type ThinkingLevel } from "@/lib/ai/thinking-level"
import { BUILTIN_TOOL_CONFIG_KEYS } from "@/lib/settings/builtin-tools"

/** AI SDK protocol families the sidecar's dispatch table understands. Mirrors
 *  BUILTIN_PROTOCOL_NAMES in sidecar/dispatch/protocol-adapters/provider-protocol.mjs. */
export const RESOLVER_PROTOCOLS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "cohere",
  "azure",
  "bedrock",
] as const

/** One of {@link RESOLVER_PROTOCOLS}. */
export type ResolverProtocol = (typeof RESOLVER_PROTOCOLS)[number]

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
 * Reasoning-effort tiers ("thinking levels"), ascending in depth. Re-exported
 * from the shared `@/lib/ai/thinking-level` so the CLI slider and the desktop
 * composer selector can never disagree about the ladder — that module documents
 * what `"off"` and the composite `"ultracode"` tier mean. `thinking.ts` owns the
 * effort mapping + supported-model gate; `App.tsx`/`EffortSlider.tsx` own the
 * `config.pluginTools` coupling.
 */
export { THINKING_LEVELS, EFFORT_SLIDER_LEVELS, type ThinkingLevel }

/** Status-bar segment ids the footer knows how to render, in any order. */
export const STATUS_SEGMENTS = [
  "model",
  "provider",
  /** The hosting agent backend. Renders nothing on the built-in one, so it can
   * sit in the default layout without changing the ordinary footer. */
  "backend",
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

/**
 * In-app text selection ("drag to select") for the fullscreen `scroll` mouse
 * model. With the wheel captured, the terminal's own click-drag selection is
 * gone; this re-implements it inside the TUI, against the frame Ink actually
 * drew, so it also works over SSH where a native selection can't reach the
 * local clipboard.
 *
 * `"off"` (the default) leaves input exactly as it was. `"manual"` paints the
 * highlight and waits for the copy chord. `"auto-copy"` puts the selection on
 * the clipboard the moment the drag ends — 划词自动复制.
 */
export const SELECTION_MODES = ["off", "manual", "auto-copy"] as const
export type SelectionMode = (typeof SELECTION_MODES)[number]

/** Default selection mode — off, so nothing about the historic input path
 * changes until the user opts in via `/select`. */
export const DEFAULT_SELECTION_MODE: SelectionMode = "off"

/**
 * Clipboard OSC 52 strategy for `/copy` & the copy keybinding. `"auto"` (the
 * default) uses the native helper locally but switches to the OSC 52 terminal
 * escape over SSH (or where no helper exists); `"always"` forces OSC 52;
 * `"never"` keeps only the native helper. Mirrors `tui/clipboard.Osc52Mode`.
 */
export const CLIPBOARD_OSC52_MODES = ["auto", "always", "never"] as const
export type ClipboardOsc52Mode = (typeof CLIPBOARD_OSC52_MODES)[number]

/**
 * Default ceiling (raw UTF-8 bytes) for the OSC 52 clipboard escape. Many
 * terminals silently DROP an OSC 52 sequence whose payload exceeds an internal
 * limit (xterm's default caps the control string near 100 000 bytes; once the
 * text is base64-encoded that lands around ~74 994 raw bytes), so a too-large
 * copy looks like it worked but never reaches the system clipboard. We treat
 * anything above this as a copy failure and surface a notice instead of emitting
 * a doomed escape. Tunable via `clipboard.osc52MaxBytes`; `0` disables the cap.
 */
export const DEFAULT_OSC52_MAX_BYTES = 74_994

export const clipboardSchema = z
  .object({
    osc52: z.enum(CLIPBOARD_OSC52_MODES).optional(),
    /** Max raw UTF-8 bytes allowed through the OSC 52 escape; larger copies are
     * skipped (the terminal would drop them anyway). Absent ⇒
     * {@link DEFAULT_OSC52_MAX_BYTES}; `0` disables the cap. */
    osc52MaxBytes: z.number().int().min(0).optional(),
  })
  .strict()
export type ClipboardConfig = z.infer<typeof clipboardSchema>

/**
 * CLI file-log levels, ordered least → most severe. Controls which sidecar /
 * MCP events are persisted to `~/.cognia/logs/mcp.log` (the in-TUI `/mcp logs`
 * panel always receives every event; this only gates the durable file).
 */
export const CLI_LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type CliLogLevel = (typeof CLI_LOG_LEVELS)[number]

/**
 * Logging preferences for the CLI's durable log files under
 * `~/.cognia/logs/`. Every field is optional; absent values fall back to
 * {@link CLI_LOGGING_DEFAULTS} (which reproduce the historic hard-coded
 * behavior: info+ to mcp.log, 2 MiB rotation, unrotated crash.log).
 */
export const cliLoggingSchema = z
  .object({
    /** Minimum severity persisted to `mcp.log`. */
    fileLevel: z.enum(CLI_LOG_LEVELS).optional(),
    /** Size threshold (KiB) at which `mcp.log` rotates to `mcp.log.1`. */
    mcpLogMaxKb: z.number().int().min(64).optional(),
    /** Size threshold (KiB) at which `crash.log` rotates to `crash.log.1`;
     * `0` keeps the historic append-forever behavior. */
    crashLogMaxKb: z.number().int().min(0).optional(),
  })
  .strict()
export type CliLoggingConfig = z.infer<typeof cliLoggingSchema>

/** Fully-resolved logging preferences. */
export interface ResolvedCliLoggingConfig {
  fileLevel: CliLogLevel
  mcpLogMaxKb: number
  crashLogMaxKb: number
}

/** Baseline logging behavior (matches the previous hard-coded constants). */
export const CLI_LOGGING_DEFAULTS: ResolvedCliLoggingConfig = {
  fileLevel: "info",
  mcpLogMaxKb: 2048,
  crashLogMaxKb: 1024,
}

/** Resolve the sparse `logging` config section against {@link CLI_LOGGING_DEFAULTS}. */
export function resolveCliLoggingConfig(
  logging: CliLoggingConfig | undefined
): ResolvedCliLoggingConfig {
  return { ...CLI_LOGGING_DEFAULTS, ...(logging ? stripUndefinedShallow(logging) : {}) }
}

/** Rank of a {@link CliLogLevel} for threshold comparisons (higher = more severe). */
export function cliLogLevelRank(level: string): number {
  const index = CLI_LOG_LEVELS.indexOf(level as CliLogLevel)
  // Unknown levels (e.g. "notice" from a misbehaving MCP server) rank as
  // "info" so they are neither always dropped nor always kept.
  return index === -1 ? CLI_LOG_LEVELS.indexOf("info") : index
}
/** How the `command` jumps to a line/col when opening a file. Drives the arg
 * shape in `tui/runtime/editor.describeEditor` for an editor not in its table. */
export const EDITOR_GOTO_FORMATS = ["vscode", "sublime", "vim", "jetbrains", "none"] as const
export type EditorGotoFormat = (typeof EDITOR_GOTO_FORMATS)[number]

/**
 * Preferred external editor for `/open` and the clickable file paths in tool
 * cards. Absent ⇒ auto-detected at use time (`$VISUAL` / `$EDITOR` /
 * `TERM_PROGRAM` / a PATH probe). A bare string in `config.json` is sugar for
 * `{ command: <string> }`; the object form additionally allows extra flags and
 * an explicit goto format for an editor the detector doesn't know.
 */
export const editorConfigSchema = z
  .object({
    /** The editor launcher command (e.g. `code`, `cursor`, `subl`, `nvim`). */
    command: z.string().min(1).optional(),
    /** Extra flags inserted before the file argument. */
    args: z.array(z.string()).optional(),
    /** Override how a line/col is passed for an unknown `command`. */
    gotoFormat: z.enum(EDITOR_GOTO_FORMATS).optional(),
  })
  .strict()
export type EditorConfig = z.infer<typeof editorConfigSchema>

/**
 * Overridable user-facing notice strings for the clipboard / copy commands.
 * The CLI's Ink TUI has no next-intl wiring, so these live in config: every key
 * is optional and falls back to {@link NOTICE_DEFAULTS}, letting a user retheme
 * (or localize) the copy notices from `config.json` without touching code. Only
 * STATIC strings live here — templated notices (e.g. "No reply #3 to copy.")
 * stay inline at their call sites.
 */
export const noticesSchema = z
  .object({
    /** Shown after copying the latest assistant reply. */
    copiedReply: z.string().optional(),
    /** Shown after copying a single transcript cell. */
    copiedCell: z.string().optional(),
    /** Shown when no clipboard mechanism is available / the copy failed. */
    clipboardUnavailable: z.string().optional(),
    /** Shown when the text is too large for the OSC 52 escape (see
     * {@link DEFAULT_OSC52_MAX_BYTES}). */
    clipboardTooLarge: z.string().optional(),
    /** Shown by `/copy` (and Ctrl+P) when there is no reply to copy yet. */
    noReplyToCopy: z.string().optional(),
    /** Shown by `/copy code` when no code block exists yet. */
    noCodeBlockToCopy: z.string().optional(),
    /** Shown by `/copy tool` when no tool result exists yet. */
    noToolResultToCopy: z.string().optional(),
    /** Shown by the copy chord when nothing is currently selected. */
    noSelectionToCopy: z.string().optional(),
    /** Shown by `/copy user` when no user message exists yet. */
    noUserMessageToCopy: z.string().optional(),
    /** Shown after copying the latest user message. */
    copiedUserMessage: z.string().optional(),
    /** Shown after copying the most recent code block. */
    copiedCodeBlock: z.string().optional(),
    /** Shown after copying the most recent tool output. */
    copiedToolOutput: z.string().optional(),
  })
  .strict()

export type NoticesConfig = z.infer<typeof noticesSchema>

/** Resolved notices with every key present. */
export type ResolvedNotices = Required<NoticesConfig>

/** Baseline notice strings — preserve the historic wording exactly. */
export const NOTICE_DEFAULTS: ResolvedNotices = {
  copiedReply: "Copied the last reply to the clipboard.",
  copiedCell: "Copied cell to the clipboard.",
  clipboardUnavailable: "Clipboard is unavailable.",
  clipboardTooLarge: "Content is too large to copy over OSC 52.",
  noReplyToCopy: "No reply to copy yet.",
  noCodeBlockToCopy: "No code block to copy yet.",
  noToolResultToCopy: "No tool result to copy yet.",
  noSelectionToCopy: "Nothing selected — drag over the transcript first.",
  noUserMessageToCopy: "No message of yours to copy yet.",
  copiedUserMessage: "Copied your last message to the clipboard.",
  copiedCodeBlock: "Copied the last code block to the clipboard.",
  copiedToolOutput: "Copied the last tool output to the clipboard.",
}

/** Fill missing notice keys with {@link NOTICE_DEFAULTS}. */
export function resolveNotices(notices: NoticesConfig | undefined): ResolvedNotices {
  return { ...NOTICE_DEFAULTS, ...(notices ? stripUndefinedShallow(notices) : {}) }
}

/** Default footer layout — preserves the pre-customization footer exactly. */
export const DEFAULT_STATUS_SEGMENTS: StatusSegment[] = [
  "model",
  "provider",
  "backend",
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
    /** Show the idle /settings + /inspect discoverability suffix. */
    showHints: z.boolean().optional(),
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
 * Composer inline-autosuggest config — the dim ghost text after the cursor.
 *
 * Two independent tiers, served by the shared engine in
 * `lib/chat/completion/inline/` (the same one the desktop composer uses):
 *
 *   - `local` — completion from command history and slash-command names.
 *     Free and instant, so it is opt-OUT (absent ⇒ on). This is the behaviour
 *     the TUI always had, only ranked properly.
 *   - `ai` — a model-generated continuation of the draft, resolved through the
 *     renderer LLM client. Opt-IN (absent ⇒ off), because it bills a model.
 *   - `agent` — one real agent turn, run ONLY when the user presses the key
 *     (alt+\\), never on a debounce. Opt-IN. It exists because `ai` above needs
 *     an API key the CLI can read from settings, and a Claude subscription
 *     keeps its bearer in the keyring instead — so for most users that tier
 *     silently produces nothing. A headless turn runs where the credentials
 *     are, which also makes it work for whatever provider or external agent the
 *     session is bound to.
 */
export const autosuggestSchema = z
  .object({
    /** Local history + command completion. Absent ⇒ on. */
    local: z.boolean().optional(),
    /** Model-generated continuation. Absent ⇒ off. */
    ai: z.boolean().optional(),
    /**
     * Agent-turn continuation, requested explicitly with alt+\\. Absent ⇒ off.
     * Never runs on a keystroke — see the tier note above.
     */
    agent: z.boolean().optional(),
    /** Debounce before querying the model, ms. Absent ⇒ 500. Clamped [200, 2000]. */
    debounceMs: z.number().int().positive().optional(),
  })
  .strict()

export type AutosuggestConfig = z.infer<typeof autosuggestSchema>

/**
 * Digital-twin retrieval config. The CLI has no local twin data — retrieval
 * round-trips through the running desktop app's CLI bridge and returns
 * REDACTED prompt segments. `characterId` names the twin-bound GUI
 * character whose twin should ground the CLI's turns.
 */
export const twinCliSchema = z
  .object({
    enabled: z.boolean().optional(),
    characterId: z.string().optional(),
  })
  .strict()

export type TwinCliConfig = z.infer<typeof twinCliSchema>

/** Non-secret collaboration endpoint selection for CLI/headless reads. */
export const collabCliSchema = z
  .object({
    url: z.string().url(),
    orgId: z.string().regex(/^org_[A-Za-z0-9_-]+$/),
  })
  .strict()
export type CollabCliConfig = z.infer<typeof collabCliSchema>

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
    /** Fullscreen only: let a mouse click on a collapsed tool/thinking cell
     * toggle just that cell (instead of the global Ctrl+T). Enabling it keeps
     * every cell individually measured, which turns off context-burst folding —
     * hence opt-in (default off). */
    clickToExpand: z.boolean().optional(),
    /** Maximum rendered transcript rows replayed into native scrollback after a
     * resize/repaint. Zero disables the cap; session data remains complete. */
    terminalResizeReplayMaxRows: z.number().int().min(0).max(1000000).optional(),
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
  clickToExpand: false,
  terminalResizeReplayMaxRows: 10000,
}

/** Fill missing render-pref fields with {@link RENDER_DEFAULTS}. */
/**
 * Git dev-workflow preferences consumed by the `/commit` and `/pr` controllers.
 * Every field is optional; absent values fall back to
 * {@link GIT_WORKFLOW_DEFAULTS}, which reproduce the historic hard-coded
 * behavior (protect master/main, default co-author trailer + PR footer,
 * auto-detected base branch).
 */
export const gitWorkflowSchema = z
  .object({
    /** Branches `/commit` refuses to commit to directly. */
    protectedBranches: z.array(z.string().min(1)).optional(),
    /** Append the Co-Authored-By trailer to generated commits. `true`/absent ⇒
     * the default Claude trailer; `false` ⇒ none; a string ⇒ that exact
     * trailer line. */
    coauthorTrailer: z.union([z.boolean(), z.string().min(1)]).optional(),
    /** Append the "Generated with Claude Code" footer to drafted PR bodies.
     * `true`/absent ⇒ the default footer; `false` ⇒ none; a string ⇒ that
     * exact footer. */
    prFooter: z.union([z.boolean(), z.string().min(1)]).optional(),
    /** PR base branch override. Absent ⇒ auto-detect (main → master). */
    baseBranch: z.string().min(1).optional(),
  })
  .strict()

export type GitWorkflowConfig = z.infer<typeof gitWorkflowSchema>

/** Resolved git-workflow preferences: trailer/footer collapsed to
 * `string | null` (null = don't append). */
export interface ResolvedGitWorkflowConfig {
  protectedBranches: string[]
  coauthorTrailer: string | null
  prFooter: string | null
  baseBranch: string | null
}

/** The trailer generated commits historically ended with (repo convention). */
export const DEFAULT_COAUTHOR_TRAILER =
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

/** The PR-body footer drafted PRs historically ended with. */
export const DEFAULT_PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)"

/** Baseline git-workflow preferences — the historic hard-coded behavior. */
export const GIT_WORKFLOW_DEFAULTS: ResolvedGitWorkflowConfig = {
  protectedBranches: ["master", "main"],
  coauthorTrailer: DEFAULT_COAUTHOR_TRAILER,
  prFooter: DEFAULT_PR_FOOTER,
  baseBranch: null,
}

/** Resolve the sparse `git` config section against {@link GIT_WORKFLOW_DEFAULTS}. */
export function resolveGitWorkflowConfig(
  git: GitWorkflowConfig | undefined
): ResolvedGitWorkflowConfig {
  const trailerOf = (v: boolean | string | undefined, fallback: string): string | null => {
    if (v === false) return null
    if (typeof v === "string") return v
    return fallback
  }
  return {
    protectedBranches: git?.protectedBranches ?? GIT_WORKFLOW_DEFAULTS.protectedBranches,
    coauthorTrailer: trailerOf(git?.coauthorTrailer, DEFAULT_COAUTHOR_TRAILER),
    prFooter: trailerOf(git?.prFooter, DEFAULT_PR_FOOTER),
    baseBranch: git?.baseBranch ?? null,
  }
}

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

/**
 * Derived from the shared catalog rather than hand-listed. The hand-written
 * version was missing `codeGraph`, `astGrep`, `dependencyResearch` and
 * `webclone` — and because this object is `.strict()`, a config that named one
 * of them was rejected outright, even though the CLI's tool host serves all
 * four. Deriving keeps the schema honest as categories are added.
 */
export const builtinToolsSchema: z.ZodType<Partial<BuiltinToolsConfig>> = z
  .object(
    Object.fromEntries(
      BUILTIN_TOOL_CONFIG_KEYS.map((key) => [key, z.boolean().optional()])
    ) as Record<string, z.ZodOptional<z.ZodBoolean>>
  )
  .strict() as z.ZodType<Partial<BuiltinToolsConfig>>

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
    /**
     * ADR-0090 Phase 4 — EXPLICIT experimental opt-in: run this Anthropic-
     * protocol deployment through the Claude Agent SDK via the built-in
     * Gateway (`runtimePolicy: claude-agent-sdk` + `routePolicy:
     * gateway-required`). Never implied, never written by `auto`, and never a
     * compatibility record — certification is a separate, versioned artifact
     * (Phase 5).
     */
    experimentalAgentSdk: z.boolean().optional(),
  })
  .strict()

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/**
 * Search providers supported by the shared `@cognia/web-search` package.
 *
 * Must stay a subset of that package's `SEARCH_PROVIDERS` keys: an id this
 * schema accepts but the engine does not know is validated, projected into
 * `searchProviders`, then dropped by `getEnabledProviders`, leaving the user
 * with "No search providers are enabled" and a config the CLI called valid.
 */
export const CLI_SEARCH_PROVIDER_IDS = [
  "tavily",
  "perplexity",
  "exa",
  "searchapi",
  "serper",
  "serpapi",
  "bing",
  "google",
  "brave",
] as const

export type CliSearchProviderId = (typeof CLI_SEARCH_PROVIDER_IDS)[number]

const searchProviderConfigSchema = z
  .object({
    /** Secret; prefer `credentials.json.searchProviders` or env. */
    apiKey: z.string().min(1).optional(),
    /** Google Programmable Search Engine id. */
    cx: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().positive().optional(),
  })
  .strict()

const searchProvidersSchema = z
  .record(z.string(), searchProviderConfigSchema)
  .superRefine((providers, ctx) => {
    for (const providerId of Object.keys(providers)) {
      if (!(CLI_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId)) {
        ctx.addIssue({
          code: "custom",
          message: `unsupported search provider: ${providerId}`,
          path: [providerId],
        })
      }
    }
  })

/** Non-secret search policy stored under `config.json.search`. */
/**
 * Sandbox settings, shaped to feed the shared `resolveSendOptions` ladder.
 *
 * The desktop reads the same three values off `AppSettings`; the CLI's config
 * is the same rung of the same ladder rather than a parallel mechanism, so a
 * session, a character and the app default resolve here exactly as they do
 * there.
 */
const sandboxPolicySchema = z
  .object({
    maxCpuSeconds: z.number().int().min(0).optional(),
    maxMemoryMb: z.number().int().min(0).optional(),
    network: z.enum(["off", "on", "allowlist"]).optional(),
    networkAllowlist: z.array(z.string().min(1)).optional(),
    writableRoots: z.array(z.string().min(1)).optional(),
    readableRoots: z.array(z.string().min(1)).optional(),
  })
  .strict()

const sandboxConfigSchema = z
  .object({
    /** Turn sandboxed execution on for every session this CLI runs. */
    enabled: z.boolean().optional(),
    /**
     * Which tier carries the shell. `os` is this machine's kernel sandbox.
     * `microvm` needs a registered e2b adapter and refuses without one rather
     * than quietly running on the host.
     */
    tier: z.enum(["os", "microvm"]).optional(),
    /** Resource / path / network ceiling the model can narrow but never widen. */
    policy: sandboxPolicySchema.optional(),
  })
  .strict()

export const searchConfigSchema = z
  .object({
    defaultProvider: z.enum(CLI_SEARCH_PROVIDER_IDS).optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
    fallbackEnabled: z.boolean().optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    searchType: z.enum(["general", "news", "academic", "images", "videos"]).optional(),
    searchDepth: z.enum(["basic", "advanced", "deep"]).optional(),
    recency: z.enum(["day", "week", "month", "year", "any"]).optional(),
    country: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
    includeDomains: z.array(z.string().min(1)).optional(),
    excludeDomains: z.array(z.string().min(1)).optional(),
    includeAnswer: z.boolean().optional(),
    includeRawContent: z.boolean().optional(),
    safeSearch: z.enum(["off", "moderate", "strict"]).optional(),
    cacheEnabled: z.boolean().optional(),
    cacheTTL: z.number().int().positive().optional(),
    cacheMaxEntries: z.number().int().positive().optional(),
    providers: searchProvidersSchema.optional(),
  })
  .strict()

export type CliSearchConfig = z.infer<typeof searchConfigSchema>

/** Sandbox settings as resolved from the CLI's config layers. */
export type CliSandboxConfig = z.infer<typeof sandboxConfigSchema>

/**
 * What we remember for one external agent backend.
 *
 * `model` is the id we explicitly asked that agent to run with. Absent means
 * "the agent picks" — for Codex that is `~/.codex/config.toml`, which is the
 * correct default.
 *
 * `piExtensionPolicy` is Pi's only (ADR-0119): how much of the user's own Pi
 * stack a Cognia session loads. It defaults to `isolated`, which is
 * `--no-extensions`, and that is deliberate — a Pi extension is arbitrary code
 * and Cognia's permission matrix is enforced by the bundled extension, not by
 * theirs. It has to be settable, though, because a provider contributed by a
 * user extension is not in an isolated session's model catalog at all: on a
 * machine whose models come from one, Pi offers 70 models outside Cognia and 3
 * inside it, and every turn silently ran on the wrong provider before the
 * refusal was made visible. Only Pi reads this key.
 */
export const externalBackendConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    piExtensionPolicy: z.enum(["isolated", "global", "trusted-project"]).optional(),
  })
  .strict()

export type ExternalBackendConfig = z.infer<typeof externalBackendConfigSchema>

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
    enabled: z.boolean().optional(),
    refreshIntervalMs: z.number().int().nonnegative().optional(),
    request: z
      .object({
        path: z.string(),
        useBaseUrlOrigin: z.boolean().optional(),
        method: z.literal("GET").optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    extract: descriptorExtractSchema,
  })
  .strict()

/**
 * Per-subagent provider/model override. Keyed by subagent id in
 * {@link cliConfigFileSchema.subagentModels}. Either field may be set on its
 * own: `model` alone swaps the model within the inherited provider; `provider`
 * alone re-routes to another configured provider (taking its default model).
 * Both empty would be meaningless, so the entry is required to carry ≥1 field —
 * the `/agents models` panel deletes the entry entirely on "inherit".
 */
export const subagentModelOverrideSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.provider || v.model), {
    message: "subagent model override needs a provider or model",
  })

export type SubagentModelOverride = z.infer<typeof subagentModelOverrideSchema>

/**
 * The `config.json` shape. Every field is optional — an empty file is valid and
 * resolves entirely from defaults + env + flags.
 */
export const cliConfigFileSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    /**
     * Wire dialect for the ACTIVE provider, bound onto its slot the same way a
     * top-level `model` is. This is the generic-override face of
     * `providers.<id>.protocol`, reachable from `--protocol` and
     * `COGNIA_PROTOCOL`, so pointing the CLI at a self-hosted or proxy endpoint
     * does not require hand-editing config.json. Without it, an
     * Anthropic-format endpoint could only be reached by picking a provider id
     * that happens to already speak Anthropic — the base URL, key, and model
     * were all overridable but the dialect they are spoken in was not.
     */
    protocol: z.enum(RESOLVER_PROTOCOLS).optional(),
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
    /**
     * OS-level sandboxing for the model's shell and file tools (ADR-0028).
     *
     * Off by default. When on, `resolveSendOptions` denies the unsandboxed
     * Bash / Edit / Write (and the sidecar's lowercase twins and the
     * process-execution escape hatches) and steers the model to the four
     * `sandbox_*` tools, which run through the `cognia-sandbox-exec` helper.
     * A host with no sandbox backend refuses those calls rather than running
     * them unconfined, so turning this on can leave a session with no shell at
     * all. That is the intended failure rather than a silent unconfined run.
     * Whether a backend is actually enforcing is what the `sandbox/status` RPC
     * answers, from an active confinement probe rather than from this field.
     *
     * Turning it on implies the plugin runtime (`session-context.ts`), because
     * the four `sandbox_*` tools ARE plugin tools.
     */
    sandbox: sandboxConfigSchema.optional(),
    /** Provider-backed web search settings for the desktop-independent CLI. */
    search: searchConfigSchema.optional(),
    /**
     * Opt-in automatic tier routing (default off). When on, a one-shot/headless
     * `run` scores the prompt's difficulty and routes it to the cheapest capable
     * tier alias (fast/balanced/powerful), seeded from the enabled providers.
     * See `lib/routing/auto-tier.ts`; toggle via `/route auto on|off`.
     */
    autoRoute: z.boolean().optional(),
    /** Let the agent call the Skill tool to load a skill's instructions. Default off. */
    skillTool: z.boolean().optional(),
    /** Let the agent call the SlashCommand tool to run a slash command. Default off. */
    slashCommandTool: z.boolean().optional(),
    /**
     * Per-subagent provider/model overrides (subagent id → {@link
     * SubagentModelOverride}), edited from the `/agents models` panel. Overlaid
     * onto a discovered subagent's definition before dispatch, so it wins over
     * the agent's markdown frontmatter `model`/`provider`. Absent ids inherit
     * (frontmatter, else the active provider's default model).
     */
    subagentModels: z.record(z.string(), subagentModelOverrideSchema).optional(),
    /** Customizable footer: which segments to show, in order, and the palette. */
    statusBar: statusBarSchema.optional(),
    /** Terminal mascot (enabled + style). Absent ⇒ shown in the `clawd` style. */
    mascot: mascotSchema.optional(),
    /** Digital-twin retrieval over the desktop CLI bridge. Absent ⇒ off. */
    twin: twinCliSchema.optional(),
    /** Collaboration plane used by the headless brain for read-only mirroring. */
    collab: collabCliSchema.optional(),
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
    /** Git dev-workflow preferences for `/commit` and `/pr` (protected
     * branches, co-author trailer, PR footer, base branch). Absent ⇒
     * {@link GIT_WORKFLOW_DEFAULTS}. */
    git: gitWorkflowSchema.optional(),
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
    /** In-app drag-to-select over the rendered frame (`/select`). `"off"`
     * (default) leaves input untouched; `"manual"` paints a highlight the copy
     * chord picks up; `"auto-copy"` copies the moment the drag ends. Requires
     * the fullscreen layout with the `"scroll"` mouse model. */
    selection: z.enum(SELECTION_MODES).optional(),
    /** Vim editing mode for the composer (`/vim` to toggle): modal NORMAL/INSERT
     * editing with the classic motions/operators. Absent ⇒ off. */
    vim: z.boolean().optional(),
    /** Composer inline ghost-text autosuggest (local + model tiers). Absent ⇒
     * local completion on, model completion off. */
    autosuggest: autosuggestSchema.optional(),
    /** Whether the TUI updates the terminal window/tab title to reflect live
     * session state (working / needs input / background activity / idle). Absent
     * ⇒ enabled; set `false` to leave the terminal title untouched. */
    terminalTitle: z.boolean().optional(),
    /** Whether to ring the terminal bell when a turn finishes (so you can tab
     * away during a long run and be alerted). Absent ⇒ off; only fires for turns
     * that ran long enough to be worth a notification. */
    notify: z.boolean().optional(),
    /** Whether turn/background-run completion (and errors) also fire an OSC
     * desktop notification, not just the terminal bell — so an unfocused terminal
     * still pops a native alert. Only takes effect when `notify` is on; set
     * `false` to keep the bell but suppress desktop popups. Absent ⇒ enabled. */
    desktopNotifications: z.boolean().optional(),
    /** Clipboard OSC 52 strategy for `/copy` & the copy keybinding. Absent ⇒
     * `"auto"` (native helper locally, OSC 52 over SSH). */
    clipboard: clipboardSchema.optional(),
    /** Durable-log preferences (`~/.cognia/logs/`): mcp.log file level +
     * rotation size, crash.log rotation. Absent ⇒ {@link CLI_LOGGING_DEFAULTS}. */
    logging: cliLoggingSchema.optional(),
    /** Preferred external editor for `/open` and clickable tool-card paths. A
     * bare string is sugar for `{ command }`. Absent ⇒ auto-detected. */
    editor: z.union([z.string().min(1), editorConfigSchema]).optional(),
    /** Overridable copy/clipboard notice strings. Absent keys ⇒
     * {@link NOTICE_DEFAULTS}. */
    notices: noticesSchema.optional(),
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
    /**
     * Idle (read) timeout for a DISPATCHED subagent turn, in milliseconds. A
     * subagent runs autonomously and several can fan out concurrently over the
     * single sidecar, so the provider gap between tool legs routinely exceeds the
     * interactive {@link streamIdleTimeoutMs} (60s) under load — which spuriously
     * killed heavy subagents. This bound is therefore far more generous and only
     * catches a genuinely dead stream; the subagent is really bounded by
     * `toolExecutionTimeoutMs` + the step/turn budget. Absent ⇒ 300000. Set `0`
     * to disable.
     */
    subagentStreamIdleTimeoutMs: z.number().int().min(0).optional(),
    /**
     * Max subagent nesting depth for `dispatch_agent` (Task). Depth 1 is a
     * subagent dispatched by the chat turn; a running subagent may itself
     * dispatch until the cap is reached, at which point the tool is simply not
     * advertised to it (the depth-N generalization of Claude Code dropping the
     * Agent tool from subagents — mirrors the desktop's dispatch path). Absent
     * ⇒ 2. Set `1` to make every subagent a leaf.
     */
    subagentMaxDepth: z.number().int().min(1).optional(),
    /** Agent runtime hosted by `chat`: built-in sidecar (default) or any
     * executable external-agent preset id (for example codex/claude-code). */
    agentBackend: z.string().min(1).optional(),
    /**
     * Per-external-backend memory, keyed by the *executable preset id* that was
     * actually launched (`codex-app-server`, `codex`, `claude-code`, …).
     *
     * Deliberately NOT folded into {@link providers}: that record is the chat
     * provider namespace, and every key in it becomes a selectable entry in the
     * `/provider` picker — an external agent is not a chat provider. Worse, the
     * preset→provider mapping sends `claude-code` to `anthropic`, so sharing the
     * record would make "switch Claude Code's model" silently rewrite the user's
     * real Anthropic chat model.
     */
    agentBackends: z.record(z.string(), externalBackendConfigSchema).optional(),
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
    /** Search API credentials, kept separate from model-provider credentials. */
    searchProviders: z
      .record(
        z.string(),
        z
          .object({
            apiKey: z.string().min(1).optional(),
            cx: z.string().min(1).optional(),
          })
          .strict()
          .refine((v) => Boolean(v.apiKey || v.cx), {
            message: "search provider credential needs an apiKey or cx",
          })
      )
      .superRefine((providers, ctx) => {
        for (const providerId of Object.keys(providers)) {
          if (!(CLI_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId)) {
            ctx.addIssue({
              code: "custom",
              message: `unsupported search provider: ${providerId}`,
              path: [providerId],
            })
          }
        }
      })
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
  /** Resolved CLI data root; runtime metadata, never read from project config. */
  cliHome?: string
  provider: string
  /** Runtime hosted by interactive chat. `builtin` keeps the Cognia sidecar;
   * any other value resolves through the external-agent preset registry. */
  agentBackend?: string
  model?: string
  /** Generic wire-dialect override, bound onto the active provider's slot
   * during resolution. See the config-file schema field. */
  protocol?: ResolverProtocol
  systemPrompt?: string
  permissionMode: (typeof PERMISSION_MODES)[number]
  /** True when a file, flag, or live user selection supplies the mode. */
  permissionModeExplicit?: boolean
  allowedTools?: string[]
  builtinTools: BuiltinToolsConfig
  providers: Record<string, ProviderConfig>
  /** Per-external-backend model memory, keyed by executable preset id. Separate
   * from {@link providers} on purpose — see the config-file schema field. */
  agentBackends?: Record<string, ExternalBackendConfig>
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
  /** OS-level sandboxing for the model's shell and file tools. Enabled by default. */
  sandbox?: CliSandboxConfig
  /** Fully layered search policy and provider credentials. */
  search?: CliSearchConfig
  /** Opt-in automatic tier routing for one-shot/headless runs. Default off. */
  autoRoute?: boolean
  /** Let the agent call the Skill tool to load a skill's instructions. Default off. */
  skillTool?: boolean
  /** Let the agent call the SlashCommand tool to run a slash command. Default off. */
  slashCommandTool?: boolean
  /** Per-subagent provider/model overrides (subagent id → override), edited from
   * the `/agents models` panel. Overlaid onto a discovered subagent's definition
   * before dispatch. Absent ids inherit (frontmatter, else active default). */
  subagentModels?: Record<string, SubagentModelOverride>
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
  /** Git dev-workflow preferences for `/commit` and `/pr`. Absent ⇒
   * {@link GIT_WORKFLOW_DEFAULTS}. */
  git?: GitWorkflowConfig
  keybindings?: Record<string, string>
  /** TUI layout model (`fullscreen` / `scrollback`). Absent ⇒ `fullscreen`,
   * resolved (and capability-gated) by `tui/layout-mode.resolveLayoutMode`. */
  layout?: LayoutMode
  /** Fullscreen mouse model (`select` / `scroll`). Absent ⇒ `scroll` (wheel
   * scrolls the transcript). Only meaningful in the fullscreen layout on a TTY. */
  mouse?: MouseMode
  /** In-app drag-to-select mode (`off` / `manual` / `auto-copy`). Absent ⇒
   * {@link DEFAULT_SELECTION_MODE}. Requires fullscreen + the `scroll` mouse model. */
  selection?: SelectionMode
  /** Vim editing mode for the composer. Absent ⇒ off. */
  vim?: boolean
  /** Composer inline autosuggest tiers. Absent ⇒ local on, model off. */
  autosuggest?: AutosuggestConfig
  /** Whether the TUI updates the terminal window/tab title with live session
   * state. Absent ⇒ enabled; `false` leaves the terminal title untouched. */
  terminalTitle?: boolean
  /** Ring the terminal bell when a turn finishes. Absent ⇒ off. */
  notify?: boolean
  /** Also fire an OSC desktop notification on completion/error (needs `notify`
   * on). Absent ⇒ enabled; `false` keeps the bell but suppresses desktop popups. */
  desktopNotifications?: boolean
  /** Clipboard OSC 52 strategy (`auto` / `always` / `never`). Absent ⇒ `auto`
   * (native helper locally, OSC 52 escape over SSH). */
  clipboard?: ClipboardConfig
  /** Durable-log preferences (mcp.log level/rotation, crash.log rotation).
   * Sparse; resolved per-use via {@link resolveCliLoggingConfig}. */
  logging?: CliLoggingConfig
  /** Preferred external editor (normalized to the object form). Absent ⇒
   * auto-detected at use time by `tui/runtime/editor.detectEditor`. */
  editor?: EditorConfig
  /** Overridable copy/clipboard notice strings. Absent ⇒ {@link NOTICE_DEFAULTS};
   * resolved per-use via {@link resolveNotices}. */
  notices?: NoticesConfig
  /** Digital-twin retrieval over the desktop CLI bridge. When `enabled` and
   * the desktop app is running, each turn fetches the REDACTED twin context
   * for `characterId` and injects it into the prompt; when the desktop is
   * unreachable the turn proceeds without twin context (one notice per
   * session). Absent ⇒ off. */
  twin?: TwinCliConfig
  /** Collaboration plane used by the headless brain for read-only mirroring. */
  collab?: CollabCliConfig
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
  /** Idle (read) timeout (ms) for a DISPATCHED subagent turn. A subagent is
   * autonomous (no user watching) and several can fan out concurrently over the
   * one sidecar — so the gap between a tool result and the model's next token
   * routinely exceeds the interactive 60s idle under provider load, which
   * spuriously killed heavy subagents ("stream idle for 60000ms"). This idle is
   * therefore far more generous than {@link streamIdleTimeoutMs}; the subagent is
   * really bounded by `toolExecutionTimeoutMs` + the step/turn budget, with this
   * only catching a genuinely dead stream. Absent ⇒ 300000; `0` disables. */
  subagentStreamIdleTimeoutMs?: number
  /** Max subagent nesting depth for `dispatch_agent` (Task). A subagent may
   * itself dispatch until this cap; at the cap the tool is withheld so the run
   * is a leaf. Cycles on the dispatch chain are always refused regardless of
   * depth. Absent ⇒ 2; `1` restores the old leaf-only CLI behavior. */
  subagentMaxDepth?: number
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
  agentBackend: "builtin",
  permissionMode: "acceptEdits",
  permissionModeExplicit: false,
  sandbox: { enabled: true, tier: "os", policy: { network: "off" } },
  builtinTools: {
    ...DEFAULT_BUILTIN_TOOLS,
    process: true,
    shellAdvanced: true,
    terminalRepl: true,
    lsp: true,
    codeGraph: true,
    astGrep: true,
  },
  providers: {},
  streamIdleTimeoutMs: 60_000,
  aiSdkMaxSteps: 256,
  toolExecutionTimeoutMs: 120_000,
  subagentStreamIdleTimeoutMs: 300_000,
  subagentMaxDepth: 2,
}
