/**
 * Shared type surface for the interactive TUI (the `cognia-agent chat` Ink app).
 *
 * Type-only module: it is excluded from coverage (TS strips it at runtime). The
 * runtime logic that operates on these shapes lives in `reducer.ts`,
 * `event-mapper.ts`, the `markdown/*` and `format/*` modules, each with its own
 * co-located test.
 */
import type { PermissionRequestEvent } from "@/lib/claude/types"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { RunStepView, RunUsageTotals } from "../runtime/workflow-run-fold"
import type { RateLimitSnapshot } from "../format/rate-limits"
import type { SettingsSectionView } from "../runtime/settings-sections"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import type { MarketplaceBrowseEntry } from "../runtime/marketplace-filter"
import type { McpPanelServer, McpPanelTool } from "../runtime/mcp-panel-model"
import type { SkillPanelRow } from "../runtime/skill-panel-model"
import type { AgentPanelRow } from "../runtime/agents-panel-model"
import type { SubagentModelRow } from "../runtime/subagent-models-model"

import type {
  ResolvedConfig,
  PERMISSION_MODES,
  StatusBarConfig,
  MascotConfig,
  EditorConfig,
  OutputStyle,
  ThinkingLevel,
  LayoutMode,
  MouseMode,
} from "../../config/schema"
import type { ProviderOption } from "../commands/provider-options"
import type { ConfigMenuRow } from "../commands/config-menu"
import type { ModelMeta } from "../runtime/model-meta"
import type { FormOverlayState } from "./form"
import type { SessionAnalysis } from "../format/usage-analysis"
import type { ProviderLimits } from "@/types/subscription"

export type PermissionMode = (typeof PERMISSION_MODES)[number]

// ── Transcript cells (committed history) ──────────────────────────────────────

export interface UserCell {
  id: string
  kind: "user"
  text: string
}

/** An assistant reply. `raw` is the model's exact markdown; components tokenize. */
export interface AssistantCell {
  id: string
  kind: "assistant"
  raw: string
}

export interface ThinkingCell {
  id: string
  kind: "thinking"
  text: string
  collapsed: boolean
}

export type ToolStatus = "running" | "done" | "error"

export interface ToolCell {
  id: string
  kind: "tool"
  /** Correlation key from the capture stream (toolName + serialized input). */
  callKey: string
  toolName: string
  input: Record<string, unknown>
  status: ToolStatus
  result?: unknown
  isError?: boolean
  collapsed: boolean
}

export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

export interface TodoCell {
  id: string
  kind: "todo"
  todos: Todo[]
}

export interface ErrorCell {
  id: string
  kind: "error"
  message: string
}

/** Non-error system notice (e.g. "Pushed to desktop", "Fresh session"). */
export interface NoticeCell {
  id: string
  kind: "notice"
  message: string
}

/** A `!command` shell-out and its captured output. */
export interface BashCell {
  id: string
  kind: "bash"
  command: string
  output: string
  status: "running" | "done" | "error"
  exitCode?: number
  /** Moved to the background (Ctrl+B): keeps running but is no longer the
   * foreground Ctrl+C target. Cleared once the command settles. */
  background?: boolean
}

/**
 * A plan proposed by the agent at the end of a plan-mode turn. Rendered as a
 * framed "Proposed plan" card (distinct from a normal assistant reply) so the
 * user can review it before approving. `raw` is the model's markdown.
 */
export interface PlanCell {
  id: string
  kind: "plan"
  raw: string
}

export type Cell =
  | UserCell
  | AssistantCell
  | ThinkingCell
  | ToolCell
  | TodoCell
  | ErrorCell
  | NoticeCell
  | BashCell
  | PlanCell

// ── In-flight (current streaming turn) ────────────────────────────────────────

export interface Inflight {
  /** Accumulated assistant text not yet committed to an AssistantCell. */
  text: string
  /** Accumulated reasoning not yet committed to a ThinkingCell. */
  thinking: string
  /**
   * Tool cells for the current turn that are still resolving. They live here
   * (outside `<Static>`) so status transitions (⏳→✓, ⏳→✗) re-render instantly
   * in the live frame. Once a tool completes (or the turn ends) the cell is moved
   * to `cells` and written to the scrollback once.
   */
  tools: ToolCell[]
}

export type TurnStatus = "idle" | "streaming" | "aborting"

// ── Background activity (goal loop, workflow run, subagent dispatch) ───────────
// These run outside the normal chat turn, so they get their own status pill.

export type ActivityKind = "goal" | "workflow" | "agent" | "team" | "loop"

export interface ActivityState {
  kind: ActivityKind
  label: string
  /** Turns completed so far (goal/agent loops). */
  turns?: number
  /** Total expected iterations, when known (e.g. a `/loop --n 5`). Enables a
   * determinate progress bar in the activity pill. */
  max?: number
  /** A short status note (e.g. the current step). */
  note?: string
  status: "running" | "done" | "error"
}

/** Live per-node progress for a `/workflow run` in flight (panel above composer). */
export interface WorkflowRunState {
  steps: RunStepView[]
  /** succeeded + failed + skipped */
  completed: number
  /** id of the running step (centres the panel's sliding window). */
  currentId?: string
  /** Run-level token/cost totals (live, from the folded `step_usage` stream). */
  usage?: RunUsageTotals
  /** Raw run events for the in-flight run, so the step inspector (Ctrl+I) can
   * surface per-step logs / output / usage without a separate Dexie read. */
  events?: WorkflowRunEventRow[]
}

/**
 * Active Workflow Copilot mode — the CLI counterpart of the desktop's
 * `session.kind === "workflow-editor"` editor session. While set, the composer
 * routes free-text to a dedicated copilot agent (built with `sessionKind`
 * `"workflow-editor"`) instead of plain chat, and the agent's `wf_propose_batch`
 * proposals surface as an Apply/Discard confirm overlay. Undefined ⇒ not in
 * copilot mode.
 */
export interface CopilotModeState {
  /** Dexie workflow id the copilot is editing (also the editor-store registry key). */
  workflowId: string
  /** Workflow display name (shown in the Footer/Banner indicator). */
  name: string
  /** True when this workflow was freshly created by `/workflow create` (vs `edit`). */
  isNew: boolean
  /** Set once an Apply/Discard cycle has mutated the draft since the last save. */
  dirty: boolean
  /** Proposal id of the open proposal awaiting Apply/Discard, if any. */
  pendingProposalId?: string
}

/**
 * Cumulative token/cost totals for the whole session. The per-turn SDK result
 * reports usage for that turn only (each CLI turn is a fresh query), so the
 * footer's "session cost / tokens" are summed here while {@link TuiState.usage}
 * keeps the latest turn's figures for the context-window gauge.
 */
export interface SessionTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
}

/** Per-tool call/error tally for the usage panel's "top tools" breakdown. */
export interface ToolStat {
  calls: number
  errors: number
}

// ── Overlays (modal selection UIs over the composer) ──────────────────────────

export type PermissionChoiceValue = "allow" | "allow_always" | "deny"

export interface PermissionChoice {
  label: string
  value: PermissionChoiceValue
}

export interface SessionSummary {
  sessionId: string
  /** First user message, truncated — a human-readable label. */
  title: string
  turns: number
  updatedAt: number
}

/** Health + context snapshot shown by the `/status` panel. */
export interface StatusReport {
  version: string
  provider: string
  model: string
  modelValid: boolean
  auth: string
  credentialedProviders: string[]
  cwd: string
  gitBranch: string | null
  contextPct: number
  contextTokens: number
  contextWindow: number
  dbSnapshotExists: boolean
}

/** One crash report on disk, summarized for the `/doctor` panel. */
export interface CrashReportItem {
  stem: string
  capturedAt?: string
  kind?: "panic" | "native"
  sizeBytes: number
  hasTxt: boolean
  hasJson: boolean
  hasDmp: boolean
}

/** Comprehensive diagnostic report shown by the `/doctor` panel. */
export interface DoctorReport {
  version: string
  provider: string
  model: string
  modelValid: boolean
  auth: string
  credentialedProviders: string[]
  cwd: string
  dbSnapshotExists: boolean
  dbSnapshotPath: string
  crashReportsDir: string | null
  logsDir: string | null
  crashReportCount: number
  latestCrash?: CrashReportItem
  logDirBytes: number
}

/** A row in the generic {@link Overlay} `select` list. */
export interface SelectItem {
  /** Stable id passed to the `onSelectCommand` when this row is chosen. */
  id: string
  label: string
  hint?: string
}

/** One inspectable transcript unit (a tool/bash/subagent cell with output),
 * surfaced in the `inspect` overlay so the user can jump to any past output's
 * full, syntax-highlighted view without scrolling. */
export interface InspectItem {
  /** The source cell's id (so Enter can open that cell's full output). */
  cellId: string
  /** Display label for the row (icon + tool/command). */
  label: string
  /** Compact one-line summary (file path / command / pattern). */
  summary: string
  /** Result magnitude in lines (0 when no result yet). */
  lines: number
  /** Whether the cell errored (drives the row colour). */
  isError: boolean
}

export type Overlay =
  | { kind: "none" }
  | { kind: "permission"; req: PermissionRequestEvent; choices: PermissionChoice[]; index: number }
  | { kind: "slash"; query: string; index: number }
  | { kind: "files"; token: string; completions: string[]; index: number }
  // `/model` switcher. `options` is the FULL provider catalog; `query` is the
  // live typeahead filter (the list can run to hundreds of OpenRouter ids), and
  // `index` points into the FILTERED view, not `options` — so navigation and
  // selection always track what's on screen.
  | { kind: "model"; options: string[]; index: number; query: string }
  | { kind: "mode"; options: PermissionMode[]; index: number }
  // Reasoning-effort slider (replaces the old vertical `thinking` list). `off`
  // mirrors the "use model default" checkbox; `index` points into the non-off
  // levels (`EFFORT_SLIDER_LEVELS`). Seed values are derived from the persisted
  // `thinkingLevel` via `deriveEffortSliderState`; the live state during editing
  // lives in the `EffortSlider` component, not here.
  | { kind: "effortSlider"; off: boolean; index: number }
  | { kind: "provider"; options: ProviderOption[]; index: number }
  | { kind: "config"; rows: ConfigMenuRow[]; index: number }
  | { kind: "sessions"; items: SessionSummary[]; index: number; query?: string }
  | { kind: "usage" }
  // Subscription limits/usage panel (`/limits`, alias `/subscription`). Renders
  // Claude-Code-style utilization bars across every configured subscription
  // account plus the local session analysis. Data is fetched by the limits
  // controller before opening (snapshots) — view-only here.
  | {
      kind: "limits"
      snapshots: ProviderLimits[]
      analysis: SessionAnalysis
      now: number
      /** Live API rate-limit reading captured this session (optional). */
      rateLimits?: RateLimitSnapshot
      /** Active provider id — its block is badged `● active` and always shown. */
      activeProvider?: string
    }
  | { kind: "help" }
  // Ctrl+R reverse-history-search. `query` is refined as the user types; `match`
  // + `matchIndex` are the current hit from the pure `searchHistory` matcher
  // (matchIndex feeds the next Ctrl+R cycle as its `fromIndex`). All view state
  // lives here so the reducer stays the single source of truth.
  | { kind: "historySearch"; query: string; match: string | null; matchIndex: number }
  | { kind: "status"; report: StatusReport }
  // Comprehensive diagnostic report shown by `/doctor`.
  | { kind: "doctor"; report: DoctorReport }
  // Generic list overlay any feature can open without touching App per-feature.
  // Picking row `i` re-dispatches `/${onSelectCommand} ${items[i].id}`. When
  // `onSelectCommand` is omitted the list is view-only — Enter just closes it.
  | {
      kind: "select"
      title: string
      items: SelectItem[]
      index: number
      onSelectCommand?: string
      query?: string
    }
  // Tool-output inspector (`/inspect`, default Ctrl+G). A picker of every
  // tool/bash/subagent cell that produced output, newest-first; Enter opens the
  // chosen cell's full, syntax-highlighted output in the document pager. Gives
  // the transcript a "jump to any output" affordance without a per-cell cursor.
  | { kind: "inspect"; items: InspectItem[]; index: number; query?: string }
  // Scrollable read-only pager. `markdown` bodies are rendered through the
  // Markdown tokenizer; `text` bodies are shown verbatim (optionally syntax-
  // highlighted by `lang`). Used by skill/tool detail and the `/view` file
  // viewer. Scroll position lives in the component (view-only state).
  | { kind: "document"; title: string; body: string; format: DocumentFormat; lang?: string }
  // Guided argument form. Navigation/edits go through FORM_UPDATE.
  | { kind: "form"; form: FormOverlayState }
  // Plan-approval prompt shown after a plan-mode turn proposes a plan. The user
  // approves (→ switch to build mode + proceed) or keeps planning. `raw` is the
  // proposed plan (already shown as a PlanCell above); `savedTo` is its on-disk
  // path when persistence succeeded; `prevPlan` is the previously proposed plan
  // in this session (when any) so the overlay can show a `+A −R` revision badge.
  | { kind: "plan"; raw: string; index: number; savedTo?: string; prevPlan?: string }
  // One-step confirm/cancel prompt with a scrollable body preview. Used by
  // `/init` (preview a generated/rewritten AGENTS.md before overwriting). Enter
  // dispatches `/${onConfirmCommand}`; Esc closes (and dispatches
  // `/${onCancelCommand}` when set). The body renders through the same
  // markdown/text pipeline as the `document` pager.
  | {
      kind: "confirm"
      title: string
      body: string
      format: DocumentFormat
      onConfirmCommand: string
      onCancelCommand?: string
    }
  // Interactive plugin-marketplace browser: a search box + section tabs over the
  // fetched catalog. Query/section/highlight live in the component (like the
  // historySearch overlay); Enter previews the selected entry (`plugin preview
  // <installRef>`), Esc closes. The full fetched list is cached here so filtering
  // is client-side and instant.
  | { kind: "marketplace"; entries: MarketplaceBrowseEntry[] }
  // Unified settings panel (`/settings`). A sectioned master-detail hub that
  // aggregates every tunable knob: `sections` is the snapshot built by
  // `settingsSections(config)` at open time, `section` is the active section
  // index (Tab/←→ switch), `index` is the highlighted row within it (↑↓ move).
  // Enum/boolean rows apply inline; delegate/form rows open an existing overlay.
  | { kind: "settings"; sections: SettingsSectionView[]; section: number; index: number }
  // Interactive MCP-server panel (`/mcp`). A live status board: each row carries
  // a coloured-bullet badge (connected / needs-auth / failed / disabled) that
  // mutates as the async probe resolves (`MCP_STATUS_PATCH`). Query/highlight
  // live in the component; per-row actions (space toggle · a auth · r reconnect ·
  // enter → per-tool list · n new) route back through callbacks. `probing` flags
  // the in-flight initial probe so the header can show a spinner.
  | { kind: "mcp"; servers: McpPanelServer[]; probing: boolean }
  // A single MCP server's per-tool enable/disable list (drill-down from the MCP
  // panel). Space toggles a tool (writes the `disabledTools` overlay → the
  // model's `disallowedTools`); Esc returns to the server panel.
  | { kind: "mcpTools"; server: string; tools: McpPanelTool[] }
  // Interactive Skills panel (`/skill`). One browsable row per skill with the
  // rich metadata the old flat list hid (origin · category · usage · validation
  // warnings) and an enabled badge. Space toggles for the session, Enter opens
  // the detail pager, n/d create/delete. Query/highlight live in the component.
  | { kind: "skills"; rows: SkillPanelRow[] }
  // Interactive agents panel (`/agents`, default Ctrl+B). A live board of the
  // sub-agents running now — in-turn dispatches + background runs (live + settled
  // from the journal). Index/highlight live in the component (like `mcp`); Enter
  // opens a settled background run's output in the document pager, Esc closes.
  | { kind: "agents"; rows: AgentPanelRow[] }
  // The live "agent run page" — switch into one sub-agent's run and watch its
  // streamed text / reasoning / tool activity token-by-token (read from the
  // live-output store by `liveId`; the title/task are the static identity). Esc
  // returns to the agents panel / chat.
  | { kind: "agentRun"; liveId: string; name: string; task: string }
  // `/agents models` panel — assign a provider/model to each dispatchable
  // subagent. A controlled master list (cursor `index` in the overlay, like
  // `settings`): ←/→ cycles the model, `p` the provider, `r` resets to inherit;
  // each edit persists to `config.subagentModels` and reopens with fresh rows.
  | { kind: "subagentModels"; rows: SubagentModelRow[]; index: number }
  // `ask_user` elicitation prompt (model-initiated). Opened when the agent calls
  // the `ask_user` tool — the request round-trips through `useAskUserStore`, the
  // App mirrors the active prompt into this overlay, and the AskUserDialog's
  // submission resolves the blocked tool call. `request` is the parsed prompt
  // (question + options + flags); the dialog owns its draft (selection + text).
  | { kind: "askUser"; request: AskUserRequest }
  // `/menu` command center — a searchable, clickable index over the curated
  // quick actions PLUS every visible registry command (see
  // `build-command-palette`). Each row carries the slash command it runs when
  // picked. Reducer-owned cursor + typeahead (`index`/`query`) so it renders
  // through the shared SelectList like `select`. The list can run to dozens of
  // commands, so the 🔎 search row is always on.
  | { kind: "quickActions"; rows: QuickActionRow[]; index: number; query?: string }

/** One row of the `/menu` command center. Picking it runs {@link command}. */
export interface QuickActionRow {
  /** Stable id (also the row key). */
  id: string
  /** Display label, with a leading glyph. */
  label: string
  /** Muted right-hand hint — current value or a one-line description. */
  hint?: string
  /** The slash command line this row runs when chosen (e.g. `/model`). */
  command: string
}

/** How a {@link Overlay} `document` body should be rendered. */
export type DocumentFormat = "markdown" | "text"

// ── Input editor state ────────────────────────────────────────────────────────

export interface InputBuffer {
  /** Logical lines (no trailing newlines). Always at least one line. */
  lines: string[]
  cursorRow: number
  cursorCol: number
}

/** A single reducer-applied editor operation (see the INPUT_EDIT action). The
 * reducer maps each to the matching `input/buffer` transform on the live buffer. */
export type InputEditOp =
  | { op: "insert"; text: string }
  | { op: "newline" }
  | { op: "backspace" }
  | { op: "delete-word" }
  | { op: "kill-to-start" }
  | { op: "kill-to-end" }
  | {
      op: "move"
      dir: "left" | "right" | "up" | "down" | "home" | "end" | "word-left" | "word-right"
    }

export interface HistoryState {
  /** Past submissions, oldest first. */
  entries: string[]
  /** -1 = editing the live draft; otherwise an index into `entries`. */
  index: number
  /** The draft stashed when history navigation began. */
  draft: string
}

export interface InputState {
  buffer: InputBuffer
  history: HistoryState
  /** Collapsed paste placeholders → their full text, keyed by placeholder id. */
  pastes: Record<string, string>
  /** Cursor position snapshotted when an overlay opened, so it can be restored
   * when the overlay closes without the buffer text having changed. Absent when
   * no overlay is open (or after a restore/clear). */
  savedCursor?: { row: number; col: number }
  /** Undo stack — prior buffer states pushed on each TEXT change (cursor-only
   * moves don't snapshot). Oldest → newest; capped. Ctrl+Z pops to here. */
  undo: InputBuffer[]
  /** Redo stack — states popped by undo, restored by Ctrl+Y. Cleared on any new
   * text edit. */
  redo: InputBuffer[]
}

// ── Root state ────────────────────────────────────────────────────────────────

export interface TuiState {
  sessionId: string
  config: ResolvedConfig
  /**
   * Session phase. `"startup"` shows only the welcome banner + trust gate (the
   * Claude-Code-style "do you trust this folder?" onboarding); `"chat"` is the
   * normal transcript + composer view. Starts `"chat"` when the cwd was already
   * trusted on a prior launch, otherwise `"startup"`.
   */
  phase: "startup" | "chat"
  cells: Cell[]
  inflight: Inflight
  overlay: Overlay
  input: InputState
  /** The latest turn's usage — drives the context-window gauge. */
  usage?: UsageInfo
  /**
   * Active model's context window + pricing, resolved from the models.dev
   * catalog. Drives the per-model context gauge and the cost fallback. Absent
   * until the async resolution lands (then the pattern-table window applies).
   */
  modelMeta?: ModelMeta
  /** Cumulative cost/token totals across every turn this session. */
  sessionTotals: SessionTotals
  /** Cumulative cost/token totals broken down by the model that ran each turn,
   * keyed by model id — feeds the usage panel's "Usage by model" table (mirrors
   * Claude Code's `/usage`). The turn's model is resolved from the active config
   * at accumulation time. */
  modelTotals: Record<string, SessionTotals>
  /** Per-turn total tokens (prompt incl. cache + output), capped — feeds the
   * usage panel's token-trend sparkline. Oldest → newest. */
  usageHistory: number[]
  /** Per-turn USD cost (SDK figure or priced estimate), capped — feeds the usage
   * panel's cost-trend sparkline. Oldest → newest, index-aligned with usageHistory. */
  costHistory: number[]
  /** Per-tool call/error tallies this session — feeds the usage panel's
   * "top tools" breakdown. Keyed by the raw tool name. */
  toolStats: Record<string, ToolStat>
  /** Latest LIVE Anthropic API rate-limit reading, parsed from the sidecar's
   * `usage_headers` channel. Drives the `/limits` panel's live block + the
   * optional `ratelimit` footer segment. Absent until the first API response. */
  rateLimits?: RateLimitSnapshot
  /** Whether a `usage` stream event already landed this turn (guards double-count). */
  usageSeenThisTurn: boolean
  turnStatus: TurnStatus
  /** A background runtime run (goal / workflow / subagent), if one is active. */
  activity?: ActivityState
  /** Live workflow run panel state; undefined when no run is in flight. */
  workflowRun?: WorkflowRunState
  /** Active Workflow Copilot mode; undefined when not editing a workflow. */
  copilot?: CopilotModeState
  /**
   * The most recent plan proposed in plan mode (raw markdown + the `seq` of the
   * PlanCell that carries it). Bumped on each plan capture so the App can react
   * exactly once — persist it and open the approval overlay. Drives `/plan`
   * (re-show the last plan). Absent until the first plan-mode turn proposes one.
   * `prevRaw` carries the plan this one superseded (when any) so the approval
   * overlay can show how the revision changed.
   */
  lastPlan?: { raw: string; seq: number; prevRaw?: string }
  /** True when an `ExitPlanMode` tool call captured a plan during the current
   * turn. Suppresses the `looksLikePlan` fallback in TURN_COMMIT (so a plan
   * isn't captured twice) and guards against a duplicate capture from an
   * assistant-snapshot echo. Reset at TURN_START and RESET. */
  planCapturedThisTurn: boolean
  /** Epoch ms of the last bare Ctrl+C (for the double-press-to-exit guard). */
  lastCtrlCAt?: number
  /** Pending instruction-file change staged by `/init create` / `/init rewrite`,
   * awaiting confirmation. `target` is the absolute path to (over)write,
   * `content` the proposed body. `/init apply` writes it; the confirm overlay's
   * cancel (or a fresh stage) clears it. Absent when nothing is staged. */
  initDraft?: { target: string; content: string }
  /** Pending `btw` steer messages typed while a turn or a goal/loop run is in
   * flight. The active driver (or the next plain turn) drains and delivers them
   * at the next turn boundary, so steering never interrupts the running turn. */
  steerQueue: string[]
  /** Persistent detailed-output mode (Ctrl+O). When on, tool/thinking cells
   * render expanded regardless of their per-cell collapsed flag. */
  verbose: boolean
  /** Bumped to force the `<Static>` transcript to re-key and re-print every cell
   * — the only way to repaint committed scrollback (after a resize, a verbose
   * toggle, or expand/collapse-all), since `<Static>` never re-renders in place. */
  renderEpoch: number
  exit: boolean
  /** Monotonic counter feeding unique cell ids without Date.now/Math.random. */
  seq: number
  /** Monotonic counter bumped on every live stream-activity action (text /
   * thinking / tool / usage delta). The App watches it to timestamp "last
   * activity" and surface the stall hint when the stream goes silent. */
  streamSeq: number
  /** Active backtrack-to-edit selection: the index in `cells` of the user
   * message currently highlighted for editing. Absent when not selecting. */
  backtrack?: { index: number }
  /** Committed edit target: the index in `cells` of the user message whose text
   * is loaded in the composer. Submitting forks the conversation here, discarding
   * every later turn. Absent when not editing. */
  editTarget?: { index: number }
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type TuiAction =
  // Streaming (from the capture stream via event-mapper)
  | { type: "INFLIGHT_TEXT"; delta: string }
  | { type: "INFLIGHT_THINKING"; delta: string }
  | { type: "TOOL_CALL"; callKey: string; toolName: string; input: Record<string, unknown> }
  | {
      type: "TOOL_RESULT"
      toolName: string
      /** Correlation key (toolName + serialized input) when the result could be
       * matched back to its originating tool_use block — lets the reducer pair a
       * result with the exact running cell even when several share a tool name. */
      callKey?: string
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  // Streaming usage (from the SDK result message, via the capture stream)
  | { type: "SET_USAGE"; usage: UsageInfo }
  | { type: "SET_RATE_LIMITS"; snapshot: RateLimitSnapshot }
  // A context-compaction boundary crossed (auto threshold or a manual `/compact`),
  // surfaced from the capture stream / the manual-compact runner.
  | { type: "COMPACT_BOUNDARY"; trigger: "manual" | "auto"; preTokens: number; postTokens: number }
  // Active model's resolved context window + pricing (from the catalog)
  | { type: "SET_MODEL_META"; meta: ModelMeta }
  // Turn lifecycle (from the turn engine)
  | { type: "TURN_START"; prompt: string }
  | { type: "TURN_COMMIT"; result: RunAndCaptureResult }
  | { type: "TURN_ERROR"; message: string }
  | { type: "TURN_ABORTED" }
  // Background activity (goal / workflow / subagent runs)
  | { type: "ACTIVITY_START"; kind: ActivityKind; label: string; max?: number }
  | { type: "ACTIVITY_PROGRESS"; turns?: number; note?: string }
  | { type: "ACTIVITY_END"; status: "done" | "error"; summary?: string }
  // Live workflow run panel (per-node progress while `/workflow run` is in flight)
  | { type: "WORKFLOW_RUN_START"; steps: RunStepView[] }
  | {
      type: "WORKFLOW_RUN_STEP"
      steps: RunStepView[]
      completed: number
      currentId?: string
      usage?: RunUsageTotals
      events?: WorkflowRunEventRow[]
    }
  | { type: "WORKFLOW_RUN_END" }
  // Workflow Copilot mode (free-text routes to the copilot agent while active)
  | { type: "COPILOT_ENTER"; workflowId: string; name: string; isNew: boolean }
  | { type: "COPILOT_EXIT" }
  | { type: "COPILOT_SET_PROPOSAL"; proposalId: string }
  | { type: "COPILOT_CLEAR_PROPOSAL" }
  | { type: "COPILOT_MARK_DIRTY" }
  // Shell-out (`!command`). `id` targets a specific cell so concurrent runs
  // (e.g. a backgrounded command + a new foreground one) never cross-fill; when
  // omitted, the most-recent still-running bash cell is used (legacy callers).
  | { type: "BASH_START"; command: string; id?: string }
  /** Append streamed output to the running shell cell as the process writes. */
  | { type: "BASH_APPEND"; chunk: string; id?: string }
  | {
      type: "BASH_RESULT"
      output: string
      status: "done" | "error"
      exitCode?: number
      id?: string
    }
  /** Move a running shell cell to the background (keeps running). */
  | { type: "BASH_BACKGROUND"; id: string }
  // Cells
  | { type: "TOGGLE_COLLAPSE"; id: string }
  /** Expand every collapsed tool/thinking cell, or collapse them all when none
   * is collapsed. Bound to a global key since the transcript has no per-cell
   * cursor — one keystroke reveals (or hides) all tool output. */
  | { type: "TOGGLE_COLLAPSE_ALL" }
  /** Toggle persistent detailed-output mode (Ctrl+O). */
  | { type: "TOGGLE_VERBOSE" }
  /** Force a full transcript repaint (resize recovery). */
  | { type: "REPAINT" }
  | { type: "NOTICE"; message: string }
  | { type: "LOAD_CELLS"; cells: Cell[] }
  | { type: "RESET"; sessionId: string }
  // Backtrack-to-edit: select a prior user message (Esc/↑↓), then commit it as
  // the edit target — submitting forks the conversation there (destructive).
  | { type: "BACKTRACK_ENTER" }
  | { type: "BACKTRACK_MOVE"; dir: -1 | 1 }
  | { type: "BACKTRACK_CANCEL" }
  | { type: "BACKTRACK_COMMIT"; index: number }
  | { type: "EDIT_CLEAR" }
  // `/init` staged-draft lifecycle: stage a generated/rewritten instruction file
  // pending confirmation, then clear it once applied or cancelled.
  | { type: "SET_INIT_DRAFT"; target: string; content: string }
  | { type: "CLEAR_INIT_DRAFT" }
  // Config switches
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_THINKING"; level: ThinkingLevel; pluginTools?: boolean }
  | { type: "SET_PROVIDER"; provider: string }
  | { type: "SET_STATUS_BAR"; statusBar: StatusBarConfig }
  | { type: "SET_MASCOT"; mascot: MascotConfig }
  | { type: "SET_EDITOR"; editor: EditorConfig }
  | { type: "SET_THEME"; theme: string }
  | { type: "SET_OUTPUT_STYLE"; style: OutputStyle }
  | { type: "SET_AGENT_MODE"; modeId: string }
  | { type: "SET_LAYOUT"; layout: LayoutMode }
  | { type: "SET_MOUSE"; mode: MouseMode }
  // Generic live merge of resolved-config fields. Backs the settings panel's
  // inline toggles for knobs without a dedicated action (builtinTools, webTools,
  // skillTool, builtinHookOverrides, …) so they reflect immediately in the panel
  // and on the next session, without one SET_* action per dormant field.
  | { type: "SET_CONFIG_PATCH"; patch: Partial<ResolvedConfig> }
  // Overlays
  | { type: "OVERLAY_OPEN"; overlay: Overlay }
  | { type: "OVERLAY_CLOSE" }
  | { type: "OVERLAY_MOVE"; delta: number }
  | { type: "OVERLAY_SET_INDEX"; index: number }
  // Live-refresh the option list of an open `model` overlay (no-op if a
  // different overlay is open). Used by the OpenRouter `/model` picker: the
  // overlay opens instantly with whatever models are cached, then this swaps in
  // the full real-time `/models` catalog the moment the async sync completes —
  // so the picker stops looking "stuck" on the static fallback subset.
  | { type: "OVERLAY_REFRESH_MODEL_OPTIONS"; options: string[] }
  // Set the `/model` picker's typeahead filter (no-op unless the model overlay
  // is open). Resets the highlight to the top of the freshly-filtered list.
  | { type: "OVERLAY_MODEL_QUERY"; query: string }
  // Set the typeahead filter on a generic searchable overlay (`select`,
  // `sessions`, `inspect`, `quickActions`). Resets the highlight to the top of
  // the freshly-filtered list; no-op for any other overlay kind.
  | { type: "OVERLAY_QUERY"; query: string }
  // Live-patch one marketplace entry (by installRef) in an open `marketplace`
  // overlay — used for in-place enable/disable so the badge updates without
  // closing the browser (no-op if a different overlay is open).
  | { type: "MARKETPLACE_PATCH_ENTRY"; ref: string; patch: Partial<MarketplaceBrowseEntry> }
  | { type: "FORM_UPDATE"; form: FormOverlayState }
  // Live-patch one MCP server's status/error/toolCount into an open `mcp`
  // overlay as its async probe resolves (no-op if a different overlay is open).
  | {
      type: "MCP_STATUS_PATCH"
      name: string
      patch: Partial<Pick<McpPanelServer, "status" | "error" | "toolCount" | "enabled">>
      /** Clear the panel-level `probing` spinner (set on the last server). */
      doneProbing?: boolean
    }
  // Flip one skill row's enabled badge in an open `skills` overlay (the panel's
  // space toggle). Persistence to `skill-state.json` is done by the caller; this
  // just keeps the visible badge in sync (no-op if a different overlay is open).
  | { type: "SKILL_ROW_TOGGLE"; id: string }
  // Bulk enable/disable a set of skill rows in the open panel (Ctrl+A / Ctrl+D
  // "全开全关", scoped to whatever rows the current filter shows). Persistence to
  // `skill-state.json` is the caller's job; this just syncs the visible badges.
  | { type: "SKILL_ROWS_SET_MANY"; ids: string[]; enabled: boolean }
  // Input editor
  | { type: "INPUT_SET"; buffer: InputBuffer }
  /** Apply a single editor operation to the CURRENT buffer inside the reducer.
   * Unlike INPUT_SET (which carries a buffer precomputed from the component's
   * possibly-stale closure), this lets several keystrokes batched into one render
   * apply sequentially — without it a fast burst collapses to just the last key. */
  | { type: "INPUT_EDIT"; edit: InputEditOp }
  | { type: "INPUT_HISTORY"; history: HistoryState }
  | { type: "INPUT_ADD_PASTE"; id: string; text: string }
  | { type: "INPUT_CLEAR" }
  | { type: "INPUT_PUSH_HISTORY"; entry: string }
  | { type: "INPUT_UNDO" }
  | { type: "INPUT_REDO" }
  // Startup onboarding (trust gate + folder picker)
  /** Trust the current cwd and enter the chat phase. */
  | { type: "STARTUP_TRUST" }
  /** Switch the working directory (from the startup folder picker). */
  | { type: "SET_CWD"; cwd: string }
  | { type: "SET_ADDITIONAL_ROOTS"; roots: string[] }
  // Lifecycle
  | { type: "CTRL_C"; at: number }
  /** Clear the Ctrl+C double-press window after the hint timeout expires,
   * so the next Ctrl+C restarts the "are you sure?" cycle. */
  | { type: "CLEAR_CTRL_C" }
  /** Queue a `btw` steer message (typed while a turn / goal / loop is running). */
  | { type: "STEER_ENQUEUE"; text: string }
  /** Drop all queued steer messages (after the driver drains them). */
  | { type: "STEER_CLEAR" }
  | { type: "EXIT" }

export type { RunAndCaptureResult, CapturePermissionDecision, PermissionRequestEvent, UsageInfo }
