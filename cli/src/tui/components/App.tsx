/**
 * Root of the interactive TUI. Owns the reducer + agent session, routes slash
 * commands, handles global keys (Ctrl+C exit, Esc interrupt/cancel), and lays
 * out the transcript, the in-flight region, overlays, and the composer.
 *
 * Collaborators (session factory, handoff push, exit, clock) are injected so the
 * component tests drive it without a live sidecar.
 */
import fs from "node:fs"
import os from "node:os"
import { spawn } from "node:child_process"
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink"

import { Banner } from "./Banner"
import { ScrollView } from "./ScrollView"
import { FindBar } from "./FindBar"
import { useScroll } from "../hooks/useScroll"
import { useTranscriptCursor } from "../hooks/useTranscriptCursor"
import { cellToText } from "../format/scrollback-search"
import { resolveLayoutMode, readLayoutCapability, type LayoutCapability } from "../layout-mode"
import {
  enterAltScreen,
  exitAltScreen,
  applyMouseMode,
  resetMouse,
  type ScreenStream,
} from "../screen"
import {
  applyTerminalTitle,
  resetTerminalTitle,
  computeTitle,
  type TitleStream,
  type TitleEnv,
} from "../terminal-title"
import { parseMouseEvent } from "../input/mouse"
import { ThemeProvider } from "../theme/context"
import { RenderPrefsProvider } from "../render/context"
import { resolveTheme } from "../theme/resolve"
import { Footer } from "./Footer"
import { BottomStatus } from "./BottomStatus"
import { Inflight } from "./Inflight"
import { WorkflowRunPanel } from "./WorkflowRunPanel"
import { Mascot } from "./Mascot"
import { selectMascotMood } from "../mascot/mascot"
import { Input } from "./Input"
import { SelectList } from "./SelectList"
import { MarketplaceBrowser } from "./MarketplaceBrowser"
import { McpPanel } from "./McpPanel"
import { McpToolsPanel } from "./McpToolsPanel"
import { SkillPanel } from "./SkillPanel"
import { EffortSlider } from "./EffortSlider"
import { StartupGate } from "./StartupGate"
import { Transcript } from "./Transcript"
import type { ListDirs } from "./FolderPicker"
import { trustFolder as defaultTrustFolder } from "../../config/trusted-folders"
import { listSessions, type ReadDir } from "./sessions-list"
import { PermissionOverlay } from "./overlays/PermissionOverlay"
import { Help } from "./overlays/Help"
import { HistorySearch } from "./overlays/HistorySearch"
import { UsagePanel } from "./overlays/UsagePanel"
import { LimitsPanel } from "./overlays/LimitsPanel"
import { StatusPanel } from "./overlays/StatusPanel"
import { DoctorPanel } from "./overlays/DoctorPanel"
import { DocumentViewer } from "./overlays/DocumentViewer"
import { InspectOverlay } from "./overlays/InspectOverlay"
import { AgentsPanel } from "./overlays/AgentsPanel"
import { AgentRunPage } from "./overlays/AgentRunPage"
import { SubagentModelsPanel } from "./overlays/SubagentModelsPanel"
import {
  cycleSubagentModel,
  cycleSubagentProvider,
  recomputeSubagentModelRows,
} from "../runtime/subagent-models-model"
import { ConfirmOverlay } from "./overlays/ConfirmOverlay"
import { PlanApprovalOverlay } from "./overlays/PlanApprovalOverlay"
import { AskUserDialog } from "./overlays/AskUserDialog"
import { useAskUserOverlay } from "../hooks/use-ask-user-overlay"
import {
  readCrashReportText,
  resolveCrashLogDirs,
  type CrashLogFs,
} from "../runtime/crash-log-discovery"
import { savePlan } from "../runtime/plan-store"
import {
  planFileName,
  planTitle,
  planDecisionMode,
  PLAN_APPROVED_PROMPT,
  PLAN_REFINE_PROMPT,
  type PlanDecision,
} from "../runtime/plan"
import { catalogModelIds } from "@/lib/ai/model-options"

import { collectModelOptions, formatModelOptionLabel, modelInfoHint } from "./model-options"
import { collectProviderOptions } from "../commands/provider-options"
import { FormOverlay } from "./overlays/FormOverlay"
import { dispatchCommand } from "../commands/dispatch"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { preprocessMentions } from "../mention/preprocess"
import { skillSetEnabled } from "../runtime/skill-controller"
import {
  mcpPanel as runMcpPanel,
  mcpAuthStartupNotices,
  mcpReconnect,
  mcpToggleServerInPanel,
  mcpToggleTool,
  openMcpToolsPanel,
} from "../runtime/mcp-controller"
import {
  readEnabled as readEnabledSkills,
  setEnabled as setSkillEnabled,
  setManyEnabled as setManySkillsEnabled,
} from "../../skill/skill-state"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { buildAgents, discoverAgentFiles } from "../../agent/discover-agents"
import { cyclePermissionMode } from "../input/mode-cycle"
import { parseBang, formatBashResult } from "../commands/bash-shellout"
import {
  runShell as defaultRunShell,
  type ShellResult,
  type RunShellOpts,
} from "../../agent/run-shell"
import { registerFeatureCommands } from "../commands"
import { runRuntimeRequest } from "../runtime"
import { runGoalStreaming } from "../runtime/goal-run"
import { createCliLifecycleFirer } from "../runtime/lifecycle-firer"
import { runLoopStreaming } from "../runtime/loop-run"
import { frameSteer } from "../runtime/driven-turns"
import { buildStepInspectorDoc } from "../runtime/workflow-step-doc"
import { copilotCheckProposal } from "../runtime/workflow-copilot-controller"
import { resolveModelMeta, type ModelMeta } from "../runtime/model-meta"
import { resolveActiveModel } from "../../config/active-model"
import { shouldAutoCompact } from "../../agent/auto-compact"
import { ensureCliDb } from "../../db/bootstrap"
import { createForm, formSubmit } from "../state/form"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { isBusy, lastAssistantText } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { runningSubagents } from "../format/subagent"
import {
  countInterruptedCliBackgroundRuns,
  countRunningCliBackgroundRuns,
} from "../../agent/subagent-background-tasks"
import { getLiveSubagent } from "../../agent/subagent-live-output"
import { absoluteTopLeft } from "../input/element-position"
import { contextPercent } from "../format/usage"
import { copyToClipboard, clipboardFailureMessage, type CopyResult } from "../clipboard"
import { readClipboardImage as defaultReadClipboardImage } from "../clipboard-image"
import { searchHistory } from "../input/history-search"
import { bufferFromText, bufferText, insertText } from "../input/buffer"
import { appendHistory } from "../input/history-store"
import { useAgentSession, type CreateSession } from "../hooks/useAgentSession"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { addToolApproval, readToolApprovals } from "../../agent/tool-approvals"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import { mintSessionId } from "../../agent/run"
import { readTranscript, type TranscriptFs } from "../../agent/transcript"
import { resolveHome } from "../../config/load"
import {
  setConfigValue,
  setProviderModel,
  setStatusBarConfig,
  setMascotConfig,
  setPluginToolsConfig,
  setAdditionalRoots,
  setBuiltinTools,
  setBooleanFlag,
  setBuiltinHookOverride,
  setStringArrayConfig,
  setCustomTheme,
  setRenderConfig,
  setKeybindings,
  setSubagentModel,
} from "../../config/mutate"
import { resolveKeybindings, matchAction } from "../input/keybindings"
import { collectInspectables } from "../runtime/inspect"
import { formatToolResultBody } from "../commands/expand-command"
import { computeAddDir } from "../runtime/add-dir"
import {
  EFFORT_SLIDER_LEVELS,
  PERMISSION_MODES,
  DEFAULT_MOUSE_MODE,
  resolveRenderConfig,
  resolveNotices,
  type ThinkingLevel,
  type SubagentModelOverride,
} from "../../config/schema"
import { deriveEffortSliderState, modelSupportsEffort } from "../../config/thinking"
import { VERSION } from "../../version"
import { SettingsOverlay } from "./overlays/SettingsOverlay"
import {
  settingsSections,
  cycleEnum,
  NUMERIC_RENDER_KEYS,
  type SettingsRow,
  type SettingsApplyTarget,
} from "../runtime/settings-sections"
import type { BuiltinToolsConfig } from "@/lib/claude/types"
import type { ListDir } from "../commands/file-completer"
import type { CommandEffect } from "../commands/types"
import type { ConfigMenuRow } from "../commands/config-menu"
import type { InspectItem, SelectItem } from "../state/types"
import type {
  ResolvedConfig,
  StatusBarConfig,
  MascotConfig,
  OutputStyle,
  StatusTheme,
  MascotStyle,
} from "../../config/schema"

const DOUBLE_CTRL_C_MS = 1000

// Rows the transcript scrolls per mouse-wheel notch in the fullscreen layout.
const WHEEL_SCROLL_LINES = 3

// A terminal resize fires a burst of events during a drag. Repainting `<Static>`
// (clear screen + reprint every cell) on each one smears and flickers, so the
// heavy repaint is debounced until the drag settles. The live frame still
// reflows instantly because its width is driven by the (immediate) size hook.
const RESIZE_DEBOUNCE_MS = 120

// Clear the screen + scrollback + home the cursor. `<Static>` writes the
// transcript straight into the terminal scrollback (it is never re-rendered), so
// emptying the cell array on `/clear` does NOT erase what is already on screen —
// only wiping the terminal does. Ink repaints its (now empty) frame on top.
const CLEAR_SCREEN = "\x1B[2J\x1B[3J\x1B[H"

function clearTerminal(): void {
  if (process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN)
}

/** Position of the user message at `index` among all user messages: its 1-based
 * `pos`, the `total` user-message count, and how many `later` ones follow it.
 * Drives the backtrack/edit status line. */
function userMessageStats(
  cells: { kind: string }[],
  index: number
): { pos: number; total: number; later: number } {
  let total = 0
  let pos = 0
  cells.forEach((c, i) => {
    if (c.kind === "user") {
      total++
      if (i === index) pos = total
    }
  })
  return { pos, total, later: total - pos }
}

/** Read a theme config file, or null when it doesn't exist / can't be read. */
function readThemeFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/** Last path segment of `p` (project folder name), tolerant of either slash
 * style and trailing separators. Feeds the dynamic terminal title. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}

// Register the feature-command clusters (Cognia runtime, MCP, plugins, skills)
// on top of the core catalog. Idempotent — safe at module load.
registerFeatureCommands()

export interface AppProps {
  config: ResolvedConfig
  sessionId: string
  createSession?: CreateSession
  pushHandoff?: (sessionId: string) => void | Promise<void>
  /** Override the exit + clock for tests. */
  onExit?: () => void
  now?: () => number
  mintId?: () => string
  /** Directory lister for `@` completion; defaults to the real filesystem. */
  listDir?: ListDir
  /** Config home (`~/.cognia`); defaults to the resolved home. */
  home?: string
  /** OS home (`~`); defaults to `os.homedir()`. Threaded to the `/skill`
   * controller so it can reuse Claude Code (`~/.claude/skills`) + Codex
   * (`~/.agents/skills`) skill dirs. */
  osHome?: string
  /** Session-directory reader for `/sessions`; defaults to the real filesystem. */
  readdir?: ReadDir
  /** Transcript reader for `/sessions` + resume; defaults to the real filesystem. */
  transcriptFs?: TranscriptFs
  /** Clipboard writer for `/copy`; defaults to the OS clipboard helper. */
  copyClipboard?: (text: string) => Promise<CopyResult>
  /** Terminal wiper for `/clear`; defaults to the ANSI clear-screen sequence. */
  clearScreen?: () => void
  /**
   * Persist a top-level config key to `~/.cognia/config.json` when changed from
   * the `/config` panel; defaults to the real config writer. Returns false on
   * failure so the App can surface a notice without throwing.
   */
  persistConfig?: (key: string, value: string) => boolean
  /**
   * Remember a model for a specific provider in `~/.cognia/config.json`
   * (`providers[id].model`) when picked from `/model`; defaults to the real
   * per-provider writer. Returns false on failure so the App can surface a
   * notice without throwing.
   */
  persistProviderModel?: (providerId: string, modelId: string) => boolean
  /**
   * Flush the CLI-local Dexie after a runtime feature writes to it; defaults to
   * scheduling a debounced snapshot. Injected as a no-op by tests so they never
   * touch the real `~/.cognia/db.json`.
   */
  persistDb?: () => void
  /** Run a `!command` shell-out; defaults to the real local shell. */
  runShell?: (command: string, opts: RunShellOpts) => Promise<ShellResult>
  /** Persist an "Allow always" tool choice; defaults to the real
   * `tool-approvals.json` writer. Injected as a no-op by tests. */
  persistToolApproval?: (home: string, toolName: string) => void
  /**
   * Whether `config.cwd` is already trusted. `false` opens the app in the
   * startup phase (welcome banner + "do you trust this folder?" gate). Defaults
   * to `true` so tests render straight into chat; `mount.tsx` passes the real
   * trust-store result. */
  trusted?: boolean
  /** Persist a folder as trusted; defaults to the real trusted-folders writer. */
  trustFolderFn?: (home: string, cwd: string) => void
  /** Dirs-only lister for the startup folder picker; defaults to the real fs. */
  listDirs?: ListDirs
  /** Persist a `/statusbar` change to config.json; defaults to the real writer. */
  persistStatusBar?: (home: string, patch: StatusBarConfig) => void
  /** Persist a `/mascot` change to config.json; defaults to the real writer. */
  persistMascot?: (home: string, patch: MascotConfig) => void
  /** Persist the `pluginTools` gate (toggled by the effort slider's `ultracode`
   * tier) to config.json; defaults to the real writer. Injected as a no-op by
   * tests so they never touch the real `~/.cognia/config.json`. */
  persistPluginTools?: (home: string, enabled: boolean) => void
  /** Composer history to seed (oldest → newest); defaults to none. `mount.tsx`
   * passes the persisted `~/.cognia/history.json`. */
  initialHistory?: string[]
  /** Persist a newly-submitted composer line to the history store; defaults to
   * the real appender. Injected as a no-op by tests. */
  persistHistory?: (entry: string) => void
  /** Resolve the active model's context window + pricing from the catalog;
   * defaults to the real models.dev reader. Injected by tests so they don't
   * touch the catalog and the async dispatch stays deterministic. */
  resolveMeta?: (provider: string, model: string | undefined) => Promise<ModelMeta>
  /** Persist a captured plan to `~/.cognia/plans`; defaults to the real writer.
   * Returns the path written (or null on failure). Injected as a no-op by tests. */
  persistPlan?: (home: string, fileName: string, raw: string) => string | null
  /** Start a streaming `/goal` run; defaults to {@link runGoalStreaming}. Injected
   * by tests so they don't touch the CLI-local db / judge. */
  startGoalRun?: typeof runGoalStreaming
  /** Start a streaming `/loop` run; defaults to {@link runLoopStreaming}. Injected
   * by tests so they don't touch the CLI-local db / loop engine. */
  startLoopRun?: typeof runLoopStreaming
  /** `@` mention candidate sources for the composer popup + submit-time
   * preprocessing. Defaults to the real disk/db providers; injected by tests so
   * the composer never touches a live db / disk. */
  mentionProviders?: MentionProviders
  /** Enable + persist a skill referenced by a `@skill:` mention; defaults to the
   * real `skill-state.json` writer. Injected as a no-op by tests so they never
   * touch the real home. */
  persistSkillEnabled?: (id: string) => void
  /** Read an image off the OS clipboard (Ctrl+V). Defaults to the real
   * cross-platform helper; injected by tests so they never touch a real
   * clipboard. Resolves the temp file path, or null when the clipboard holds no
   * image. */
  readClipboardImage?: () => Promise<{ path: string } | null>
  /** Terminal capability snapshot that gates the fullscreen layout; defaults to
   * the live process (non-TTY ⇒ scrollback). Injected by tests to exercise the
   * fixed-region tree without a real TTY. */
  layoutCapability?: LayoutCapability
  /** Sink for the alternate-screen enter/exit escapes; defaults to the Ink
   * stdout. Injected by tests to assert the lifecycle. */
  screenOut?: ScreenStream
  /** True when `mount.tsx` already entered + cleared the alternate screen BEFORE
   * Ink's first paint (the production fullscreen path). The App's alt-screen
   * effect then skips the redundant enter/clear that would otherwise wipe Ink's
   * first frame and leave a blank screen until a resize. Defaults to false so
   * tests (which render App directly) still drive the full enter on mount. */
  altScreenPreEntered?: boolean
  /** Sink for the dynamic terminal-title escapes; defaults to the Ink stdout.
   * Kept distinct from {@link screenOut} so the title writes never pollute the
   * alt-screen lifecycle assertions. Injected by tests to assert the title. */
  titleOut?: TitleStream
  /** Env slice steering terminal-title adaptation (tmux / screen / dumb);
   * defaults to `process.env`. Injected by tests. */
  titleEnv?: TitleEnv
}

export function App({
  config,
  sessionId,
  createSession,
  pushHandoff,
  onExit,
  now = Date.now,
  mintId = () => mintSessionId(),
  listDir,
  home = resolveHome(process.env, os.homedir()),
  osHome = os.homedir(),
  readdir,
  transcriptFs,
  copyClipboard = (text: string) =>
    copyToClipboard(text, {
      osc52: config.clipboard?.osc52,
      osc52MaxBytes: config.clipboard?.osc52MaxBytes,
      env: process.env,
    }),
  persistConfig,
  persistProviderModel,
  clearScreen = clearTerminal,
  persistDb = () => {
    void ensureCliDb()
      .then((handle) => handle.scheduleFlush())
      .catch(() => {})
  },
  runShell = defaultRunShell,
  persistToolApproval = addToolApproval,
  trusted = true,
  trustFolderFn = defaultTrustFolder,
  listDirs,
  persistStatusBar = setStatusBarConfig,
  persistMascot = setMascotConfig,
  persistPluginTools = setPluginToolsConfig,
  initialHistory = [],
  persistHistory = (entry) => {
    try {
      appendHistory(home, entry)
    } catch {
      // best-effort — a read-only home shouldn't break the turn.
    }
  },
  resolveMeta = resolveModelMeta,
  persistPlan = savePlan,
  startGoalRun = runGoalStreaming,
  startLoopRun = runLoopStreaming,
  mentionProviders: mentionProvidersProp,
  persistSkillEnabled,
  readClipboardImage = defaultReadClipboardImage,
  layoutCapability,
  screenOut,
  altScreenPreEntered,
  titleOut,
  titleEnv,
}: AppProps) {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(tuiReducer, undefined, () =>
    createInitialState(config, sessionId, trusted, initialHistory)
  )
  const agent = useAgentSession({
    config: state.config,
    dispatch,
    // Bind the chat session to the live app id so its transcript lands under the
    // id `/export`/`/handoff`/`/resume` read (it tracks `/clear` + `/resume`).
    sessionId: state.sessionId,
    createSession,
    getCellCount: () => state.cells.length,
    // Seed the live auto-approve set from THIS app's home (not the OS home) so
    // it matches `persistToolApproval`'s store and stays hermetic under test.
    resolveApprovedTools: () => readToolApprovals(home, undefined, state.config.cwd),
  })
  const busy = isBusy(state)
  const overlayOpen = state.overlay.kind !== "none"
  const [interruptedBackgroundSubagents, setInterruptedBackgroundSubagents] = useState(0)

  // Session-enabled skill ids — drives the ●/○ badge in the `@` mention popup and
  // is kept live so a Shift+Tab toggle reflects immediately. Seeded from
  // `skill-state.json` under THIS app's home (best-effort; empty on a fresh home).
  const [enabledSkillIds, setEnabledSkillIds] = useState<Set<string>>(() => {
    try {
      return readEnabledSkills(home)
    } catch {
      return new Set<string>()
    }
  })
  // Flip a skill's enabled state from the popup: persist, refresh the live set so
  // the badge updates, and invalidate the cached SendOptions so the next turn
  // reflects the change. Routes through the injected `persistSkillEnabled` writer
  // when present (tests) but always derives the new set locally.
  const toggleSkillEnabled = useCallback(
    (id: string, enabled: boolean) => {
      try {
        setSkillEnabled(home, id, enabled)
      } catch {
        // read-only home shouldn't break the popup; the in-memory set still updates.
      }
      setEnabledSkillIds((prev) => {
        const next = new Set(prev)
        if (enabled) next.add(id)
        else next.delete(id)
        return next
      })
      agent.invalidate()
      dispatch({
        type: "NOTICE",
        message: `Skill "${id}" ${enabled ? "enabled" : "disabled"} for this session.`,
      })
    },
    [home, agent]
  )
  // Whether the composer popup currently owns input — read by the wheel handler
  // so the transcript doesn't scroll while the popup is being wheel-scrolled.
  const composerPopupOpen = useRef(false)
  // The run-state chip row in the BottomStatus, so a click on the subagent chip
  // opens the `/agents` panel (parity with Ctrl+B).
  const subagentChipRef = useRef<DOMElement | null>(null)
  // Stable callbacks for the memoized <Input>: an inline arrow / default-param
  // arrow would be a fresh reference each render and defeat React.memo, making
  // the composer re-render (and re-run slash/mention matching) on every delta.
  const handlePopupOpenChange = useCallback((open: boolean) => {
    composerPopupOpen.current = open
  }, [])
  const persistHistoryRef = useRef(persistHistory)
  useEffect(() => {
    persistHistoryRef.current = persistHistory
  }, [persistHistory])
  const handleHistoryPush = useCallback((entry: string) => {
    persistHistoryRef.current(entry)
  }, [])

  // Bridge the `ask_user` elicitation store into the overlay system: when the
  // agent calls `ask_user`, mirror the active prompt into an `askUser` overlay
  // and hand the dialog a resolver that settles the blocked tool call. Without
  // this the tool call never resolves and the turn hangs.
  const askUser = useAskUserOverlay(state.overlay.kind, dispatch)

  // `@` mention providers — shared by the composer popup and submit-time
  // preprocessing. Reuse the same skill/agent discovery the `/skill` + `/agents`
  // controllers use. Rebuilt only when the cwd / skill config changes.
  const mentionProviders = useMemo(
    () =>
      mentionProvidersProp ??
      createMentionProviders({
        cwd: state.config.cwd,
        home,
        osHome,
        roots: [state.config.cwd, home],
        externalSkills: state.config.externalSkills,
        skillDirs: state.config.skillDirs,
      }),
    [
      mentionProvidersProp,
      state.config.cwd,
      home,
      osHome,
      state.config.externalSkills,
      state.config.skillDirs,
    ]
  )
  // Resolve the active colour palette from the theme config. Re-resolves only
  // when the theme name changes (reuse/custom themes read a file; built-ins
  // don't), so the whole UI recolours in place on `/theme`. `resolveTheme` only
  // reads `config.theme`; pinning deps to the theme name avoids re-reading
  // reuse/custom theme files on every unrelated config change.
  const themePalette = useMemo(
    () => resolveTheme(state.config, { osHome, cogniaHome: home, read: readThemeFile }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.config.theme, osHome, home]
  )
  // Resolved transcript render preferences (highlight/line-numbers/truncation),
  // re-derived only when the `render` config object changes.
  const renderPrefs = useMemo(() => resolveRenderConfig(state.config.render), [state.config.render])
  // Resolved copy/clipboard notice strings (defaults ⊕ user overrides).
  const notices = useMemo(() => resolveNotices(state.config.notices), [state.config.notices])
  // Resolved keyboard bindings (defaults ⊕ user overrides), for both the global
  // chord handler below and the composer's editor chords.
  const keybindings = useMemo(
    () => resolveKeybindings(state.config.keybindings),
    [state.config.keybindings]
  )
  // Abort controller for the active background runtime run (goal/workflow/…).
  const runtimeAbort = useRef<AbortController | null>(null)
  // Timer that clears the Ctrl+C double-press window after the hint expires, so a
  // single press doesn't linger waiting for a second press forever.
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Double-Esc backtrack (Codex's "Esc twice to edit the last message"): the first
  // idle Esc arms a short window, the second pulls the last user message back into
  // the composer for editing — without touching the transcript (rewinding history
  // stays with /rewind, /retry). `armed` is mirrored to state so BottomStatus can
  // show the confirm hint; the ref is the source of truth for the key handler.
  const [backtrackArmed, setBacktrackArmed] = useState(false)
  const backtrackArmedRef = useRef(false)
  const backtrackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarmBacktrack = useCallback(() => {
    backtrackArmedRef.current = false
    setBacktrackArmed(false)
    if (backtrackTimer.current) {
      clearTimeout(backtrackTimer.current)
      backtrackTimer.current = null
    }
  }, [])
  const armBacktrack = useCallback(() => {
    backtrackArmedRef.current = true
    setBacktrackArmed(true)
    if (backtrackTimer.current) clearTimeout(backtrackTimer.current)
    backtrackTimer.current = setTimeout(() => {
      backtrackArmedRef.current = false
      setBacktrackArmed(false)
      backtrackTimer.current = null
    }, 1500)
  }, [])

  // `btw` steer mirror. The async goal/loop driver and the plain-turn drain read
  // the latest queued steer through a ref (component `state` is only the snapshot
  // at dispatch time). Kept in sync with `state.steerQueue`.
  const steerRef = useRef<string[]>(state.steerQueue)
  useEffect(() => {
    steerRef.current = state.steerQueue
  }, [state.steerQueue])
  // Drain the queued steer messages into a single framed prompt (or null when
  // empty). Clearing the reducer queue keeps the footer indicator honest.
  const takeSteer = useCallback((): string | null => {
    if (steerRef.current.length === 0) return null
    const joined = steerRef.current.join("\n")
    steerRef.current = []
    dispatch({ type: "STEER_CLEAR" })
    return joined
  }, [])

  // Reactive terminal size. `columns` drives the full-width composer/overlays
  // (so the UI fills the terminal like Claude Code) and `rows` budgets how many
  // list rows fit before scrolling. The live frame reflows the instant this
  // updates; only the heavy `<Static>` repaint below is debounced.
  const { columns, rows } = useTerminalSize()
  // Row budgets: overlays replace the composer (reserve ~8 rows for the banner
  // is in scrollback, plus footer/mascot/title/borders); inline popups sit above
  // the composer so they stay compact.
  const overlayRows = Math.max(3, rows - 8)
  const popupRows = Math.max(3, Math.min(10, rows - 6))

  // Minimal MCP deps for the interactive panel's in-place actions (toggle /
  // reconnect / tools / remove). Built per render so it tracks the live config.
  const mcpPanelDeps = () => ({ dispatch, roots: [state.config.cwd, home], home })

  // One-time boot check: warn (via a NOTICE cell) about any enabled remote MCP
  // server that needs authorization, so the user isn't surprised at the first
  // turn. Fires once per session as soon as we enter the chat phase; the probe is
  // async and never blocks the first frame.
  const mcpAuthChecked = useRef(false)
  useEffect(() => {
    if (state.phase !== "chat" || mcpAuthChecked.current) return
    mcpAuthChecked.current = true
    void mcpAuthStartupNotices({ dispatch, roots: [state.config.cwd, home], home })
  }, [state.phase, state.config.cwd, home, dispatch])

  // Effective layout: the configured preference (default `fullscreen`) gated by
  // terminal capability — a non-TTY / dumb terminal always falls back to the
  // scrollback `<Static>` tree (which is also why every existing test, rendered
  // under jsdom with no TTY, keeps the historic layout untouched).
  const capability = layoutCapability ?? readLayoutCapability()
  const fullscreen = resolveLayoutMode(state.config.layout, capability) === "fullscreen"
  // Fullscreen mouse model (default = native click-drag selection). Drives the
  // alt-screen mouse escapes below and whether the wheel scrolls the transcript.
  const mouseMode = state.config.mouse ?? DEFAULT_MOUSE_MODE

  const { stdout } = useStdout()
  // Alternate-screen lifecycle. Entering pins the banner/composer and gives the
  // transcript its own scroll viewport; the cleanup restores the user's terminal
  // (and prior scrollback) on unmount or whenever `/layout scrollback` flips the
  // mode off. The escapes are idempotent, so `mount.tsx`'s hard-exit safety net
  // can also exit without coordinating with this effect.
  const screen: ScreenStream = screenOut ?? (stdout as unknown as ScreenStream)
  // Tracks whether the alternate screen is already active. Seeded from
  // `altScreenPreEntered` so the effect below knows when `mount.tsx` already
  // entered + cleared the alt buffer BEFORE Ink's first paint: re-entering here
  // would re-issue CLEAR_HOME and wipe the frame Ink just drew, and because the
  // post-measure re-render is usually identical (content fits → offset stays 0)
  // Ink's diff writes nothing — leaving a blank screen until the next full
  // repaint (a terminal resize). Skipping the redundant enter keeps the first
  // frame on screen while still owning enter/exit for live `/layout` toggles
  // (and for tests, which render App directly with no pre-enter).
  const altScreenActive = useRef(Boolean(altScreenPreEntered) && fullscreen)
  useEffect(() => {
    if (!fullscreen) return
    if (!altScreenActive.current) {
      enterAltScreen(screen)
      // Mouse handling lives with the alt-screen lifecycle: it is only meaningful
      // (and only safe) while fullscreen owns the screen. `select` (default)
      // leaves the mouse uncaptured so native selection works; `scroll` captures
      // the wheel so it pages the transcript. A live `/mouse` toggle re-applies
      // imperatively in `applyEffect` — this only seeds the initial mode.
      applyMouseMode(mouseMode, screen)
      altScreenActive.current = true
    }
    return () => {
      resetMouse(screen)
      exitAltScreen(screen)
      altScreenActive.current = false
    }
    // `mouseMode` is intentionally NOT a dep: the initial application is gated by
    // `altScreenActive`, and live changes go through `applyEffect` so a re-enter
    // never re-issues CLEAR_HOME. eslint-disable to keep the effect enter-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, screen])

  // Dynamic terminal title: reflect the live session state in the window / tab
  // caption so a glance tells you whether the agent is working, blocked on you,
  // or idle — even when the window isn't focused. Independent of the alt-screen
  // layout (it works in scrollback mode too), so it writes to its own sink (not
  // `screen`) and is terminal-type-adapted (tmux/screen/dumb) by the module.
  const titleEnabled = state.config.terminalTitle !== false
  const titleSink: TitleStream = titleOut ?? (stdout as unknown as TitleStream)
  const awaitingInput = state.overlay.kind === "permission" || state.overlay.kind === "askUser"
  const activityKind =
    state.activity && state.activity.status === "running" ? state.activity.kind : undefined
  const titleText = useMemo(
    () =>
      computeTitle({
        busy,
        awaitingInput,
        activity: activityKind,
        dir: baseName(state.config.cwd),
      }),
    [busy, awaitingInput, activityKind, state.config.cwd]
  )
  useEffect(() => {
    if (titleEnabled) applyTerminalTitle(titleText, titleSink, titleEnv)
  }, [titleEnabled, titleText, titleSink, titleEnv])
  // Restore the terminal's default title on unmount (the per-state apply above
  // owns live updates; this is the teardown so we never strand a stale caption).
  useEffect(() => {
    if (!titleEnabled) return
    return () => resetTerminalTitle(titleSink, titleEnv)
  }, [titleEnabled, titleSink, titleEnv])

  // Scroll controller for the fullscreen viewport (no-op in scrollback mode,
  // where the terminal's native scrollback handles it).
  const scroll = useScroll()
  // Stable reference for the submit/clear re-pin (the rest of `scroll` is read
  // during render, but this one is closed over by callbacks).
  const scrollReset = scroll.reset
  // Find-in-viewport cursor (fullscreen only). Drives the FindBar, the focused
  // cell's highlight, per-cell copy, and the jump-to-match scroll below.
  const cursor = useTranscriptCursor(state.cells)
  // Jump the viewport so the focused match lands ~1/3 down, re-running as the
  // gated per-cell measurements settle (cursor.targetRow folds in their version).
  const cursorTargetRow = cursor.targetRow
  useEffect(() => {
    if (cursorTargetRow !== null) scroll.toRow(cursorTargetRow)
    // `scroll.toRow` is rebuilt every render; depend only on the target so a jump
    // fires when the focus/measurement changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorTargetRow])

  // Terminal resize recovery (scrollback mode only). `<Static>` wrote the
  // transcript into the scrollback at the OLD width; on resize Ink reflows its
  // live frame over that stale content, smearing the layout (duplicated lines,
  // stray full-width rules). Clear the screen and bump the render epoch so
  // `<Static>` remounts and re-prints every cell at the new width — debounced so
  // a drag doesn't thrash the whole scrollback on every intermediate size. In
  // fullscreen there is no `<Static>`; Ink reflows the bounded frame on its own,
  // so we skip the clear-and-repaint entirely.
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!stdout?.on || fullscreen) return
    const onResize = () => {
      if (repaintTimer.current) clearTimeout(repaintTimer.current)
      repaintTimer.current = setTimeout(() => {
        repaintTimer.current = null
        clearScreen()
        dispatch({ type: "REPAINT" })
      }, RESIZE_DEBOUNCE_MS)
    }
    stdout.on("resize", onResize)
    return () => {
      stdout.off?.("resize", onResize)
      if (repaintTimer.current) {
        clearTimeout(repaintTimer.current)
        repaintTimer.current = null
      }
    }
  }, [stdout, clearScreen, fullscreen])

  // Resolve the active model's context window + pricing from the models.dev
  // catalog whenever the provider or model changes, so the context gauge sizes
  // to the real window (not the 200k fallback) and the cost segment can price
  // turns the SDK reports as $0 (every non-Anthropic provider). Best-effort and
  // async — a missing catalog leaves the pattern-table window in place.
  const activeModel = useMemo(() => resolveActiveModel(state.config), [state.config])
  const activeProvider = state.config.provider
  useEffect(() => {
    let cancelled = false
    void countInterruptedCliBackgroundRuns({ home })
      .then((count) => {
        if (!cancelled) setInterruptedBackgroundSubagents(count)
      })
      .catch(() => {
        if (!cancelled) setInterruptedBackgroundSubagents(0)
      })
    return () => {
      cancelled = true
    }
  }, [home])

  useEffect(() => {
    let cancelled = false
    void resolveMeta(activeProvider, activeModel)
      .then((meta) => {
        if (!cancelled) dispatch({ type: "SET_MODEL_META", meta })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [resolveMeta, activeProvider, activeModel])

  // When a plan-mode turn proposes a plan (the reducer captured it as
  // `lastPlan`), persist it to `~/.cognia/plans` and open the approval prompt —
  // the OpenCode `plan_exit` flow. The ref guards against re-firing for the same
  // plan when unrelated state changes re-run the effect.
  // Keyed by session + seq so a RESET (which restarts seq from 0) can't make a
  // fresh plan collide with one already handled in a previous session.
  const handledPlanSeq = useRef<string | null>(null)
  useEffect(() => {
    const plan = state.lastPlan
    const key = plan ? `${state.sessionId}:${plan.seq}` : null
    if (!plan || handledPlanSeq.current === key) return
    handledPlanSeq.current = key
    let savedTo: string | undefined
    try {
      savedTo = persistPlan(home, planFileName(state.sessionId, plan.seq), plan.raw) ?? undefined
    } catch {
      savedTo = undefined
    }
    if (savedTo) dispatch({ type: "NOTICE", message: `Plan saved to ${savedTo}` })
    dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "plan",
        raw: plan.raw,
        index: 0,
        ...(savedTo ? { savedTo } : {}),
        ...(plan.prevRaw ? { prevPlan: plan.prevRaw } : {}),
      },
    })
  }, [state.lastPlan, state.sessionId, home, persistPlan])

  // Bridge `state.copilot` (driven by the COPILOT_* actions the runtime
  // controller dispatches) to the agent session: entering routes `send` to a
  // dedicated workflow-editor session, exiting tears it down. A ref to the
  // latest agent api keeps this effect keyed only on the workflow id (the hook
  // returns a fresh object each render), so enter/exit fires once per change.
  const agentRef = useRef(agent)
  useEffect(() => {
    agentRef.current = agent
  })

  // OpenCode-style auto-compaction: when the live context crosses the configured
  // fill threshold, compact it between turns (idle only) so a long session shrinks
  // itself instead of overflowing into dropped history. Armed off the usage
  // fraction so it fires once per crossing, not on every render — it re-arms once
  // the fraction falls back under the threshold after a compaction.
  const autoCompactArmed = useRef(true)
  useEffect(() => {
    if (state.turnStatus !== "idle") return
    const fire = shouldAutoCompact({
      usage: state.usage,
      model: activeModel,
      contextWindow: state.modelMeta?.contextWindow,
      enabled: state.config.autoCompact !== false,
      threshold: state.config.autoCompactThreshold,
    })
    if (!fire) {
      autoCompactArmed.current = true
      return
    }
    if (!autoCompactArmed.current) return
    autoCompactArmed.current = false
    void agentRef.current.compact()
  }, [
    state.usage,
    state.turnStatus,
    activeModel,
    state.modelMeta?.contextWindow,
    state.config.autoCompact,
    state.config.autoCompactThreshold,
  ])
  const copilotWorkflowId = state.copilot?.workflowId
  useEffect(() => {
    if (copilotWorkflowId) agentRef.current.enterCopilot(copilotWorkflowId)
    else void agentRef.current.exitCopilot()
  }, [copilotWorkflowId])

  const doExit = useCallback(() => {
    dispatch({ type: "EXIT" })
    if (onExit) onExit()
    else exit()
  }, [exit, onExit])

  // Startup trust gate: "Yes, proceed" trusts the current cwd and enters chat.
  const trustCwd = useCallback(() => {
    try {
      trustFolderFn(home, state.config.cwd)
    } catch {
      // A read-only home shouldn't block the session — just don't remember it.
    }
    dispatch({ type: "STARTUP_TRUST" })
  }, [home, trustFolderFn, state.config.cwd])

  // Folder picker confirmed a directory: switch cwd, trust it, and enter chat.
  // The agent's SendOptions are re-resolved so the new cwd reaches the first turn.
  const changeCwd = useCallback(
    (dir: string) => {
      try {
        trustFolderFn(home, dir)
      } catch {
        // best-effort persistence
      }
      dispatch({ type: "SET_CWD", cwd: dir })
      dispatch({ type: "STARTUP_TRUST" })
      agent.invalidate()
    },
    [agent, home, trustFolderFn]
  )

  // Best-effort write of a changed setting to `~/.cognia/config.json` so a
  // `/config`-panel switch survives the next launch. A failure (read-only home,
  // bad value) surfaces as a notice rather than throwing.
  const persist = useCallback(
    (key: string, value: string): boolean => {
      try {
        if (persistConfig) return persistConfig(key, value)
        setConfigValue(home, key, value)
        return true
      } catch {
        return false
      }
    },
    [home, persistConfig]
  )

  // Persist a model under a specific provider (per-provider memory). Keyed to the
  // provider so each one reuses its own last pick and no global pin bleeds across
  // providers. Failures are swallowed (read-only home just loses persistence).
  const persistProviderModelFn = useCallback(
    (providerId: string, modelId: string): boolean => {
      try {
        if (persistProviderModel) return persistProviderModel(providerId, modelId)
        setProviderModel(home, providerId, modelId)
        return true
      } catch {
        return false
      }
    },
    [home, persistProviderModel]
  )

  // Resolve a plan-approval choice. Either approve gear switches to a build mode
  // (auto-edits → acceptEdits, confirm-each → default) so edits are allowed,
  // persists that choice, and injects the synthetic "proceed" turn; "Keep
  // planning" (mode null) just closes the prompt and stays in plan mode.
  const onPlanDecision = useCallback(
    (decision: PlanDecision) => {
      dispatch({ type: "OVERLAY_CLOSE" })
      const mode = planDecisionMode(decision)
      if (mode) {
        persist("permissionMode", mode)
        // switchMode now mutates the LIVE session in place (no respawn), so the
        // proposed plan above is still in context when we tell the agent to
        // implement it. Await the mode switch before sending so the build-mode
        // gate is active for the implementation turn.
        void (async () => {
          await agent.switchMode(mode)
          await agent.send(PLAN_APPROVED_PROMPT)
        })()
      }
    },
    [agent, persist]
  )

  const openSessions = useCallback(() => {
    const fsRead: ReadDir = readdir ?? ((dir) => fs.readdirSync(dir))
    const items = listSessions(home, { readdir: fsRead, transcriptFs })
    if (items.length === 0) {
      dispatch({ type: "NOTICE", message: "No past sessions found." })
      return
    }
    dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "sessions", items, index: 0 } })
  }, [home, readdir, transcriptFs])

  const doResume = useCallback(
    (id: string) => {
      const cells = transcriptToCells(readTranscript(home, id, transcriptFs))
      void agent.resume(id, cells)
    },
    [agent, home, transcriptFs]
  )

  // Resume the most-recently-active session directly (the `/resume` command),
  // reusing the same session-list + resume path the `/sessions` browser uses.
  const resumeMostRecent = useCallback(() => {
    const fsRead: ReadDir = readdir ?? ((dir) => fs.readdirSync(dir))
    const items = listSessions(home, { readdir: fsRead, transcriptFs })
    if (items.length === 0) {
      dispatch({ type: "NOTICE", message: "No past sessions to resume." })
      return
    }
    doResume(items[0].sessionId)
  }, [doResume, home, readdir, transcriptFs])

  // Run a `!command` shell-out: append a live bash cell, then fill it with the
  // result. Defined above `applyEffect` so the `runBash` CommandEffect can reuse
  // it. The primary entry is `handleSubmit` (a bare `!…` line bypasses commands).
  const runBash = useCallback(
    (command: string) => {
      dispatch({ type: "BASH_START", command })
      void Promise.resolve(
        runShell(command, {
          cwd: state.config.cwd,
          // Stream output live into the cell; the final BASH_RESULT reflows it to
          // the clean formatted form (trim + exit note) once the process exits.
          onChunk: (chunk) => dispatch({ type: "BASH_APPEND", chunk }),
        })
      )
        .then((r) =>
          dispatch({
            type: "BASH_RESULT",
            output: formatBashResult(r),
            status: r.code === 0 ? "done" : "error",
            exitCode: r.code,
          })
        )
        .catch((err: unknown) =>
          dispatch({
            type: "BASH_RESULT",
            output: err instanceof Error ? err.message : String(err),
            status: "error",
          })
        )
    },
    [runShell, state.config.cwd]
  )

  // Interpret a pure CommandEffect produced by the dispatcher. The only place
  // the slash commands' side effects happen — keeps every handler unit-testable.
  const applyEffect = useCallback(
    (effect: CommandEffect) => {
      switch (effect.kind) {
        case "none":
          break
        case "notice":
          dispatch({ type: "NOTICE", message: effect.message })
          break
        case "openOverlay":
          dispatch({ type: "OVERLAY_OPEN", overlay: effect.overlay })
          break
        case "openForm":
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: {
              kind: "form",
              form: createForm(
                effect.form.specs,
                effect.form.title,
                effect.form.commandName,
                effect.form.subcommand
              ),
            },
          })
          break
        case "send":
          void agent.send(effect.prompt)
          break
        case "compact":
          // Light up the PreCompact lifecycle hook (ADR-0040 follow-up) just
          // before the context window is trimmed. Fire-and-forget observational.
          void createCliLifecycleFirer({ home, osHome })(
            "PreCompact",
            {
              agentId: "cli",
              sessionId: state.sessionId,
            },
            { payload: { focus: effect.focus ?? null } }
          )
          void agent.compact(effect.focus)
          break
        case "clear":
          // Wipe the terminal first (Static scrollback won't clear itself), then
          // reset state so Ink repaints the empty transcript onto a blank screen.
          clearScreen()
          scrollReset()
          // Drop any find cursor — its focused cell id is about to be wiped.
          cursor.clear()
          void agent.clear(mintId())
          break
        case "copy":
          void Promise.resolve(copyClipboard(effect.text)).then((res) =>
            dispatch({
              type: "NOTICE",
              message: res.ok ? notices.copiedReply : clipboardFailureMessage(res.reason, notices),
            })
          )
          break
        case "handoff":
          void Promise.resolve(pushHandoff?.(state.sessionId)).then(() =>
            dispatch({ type: "NOTICE", message: "Pushed this session to the desktop app." })
          )
          break
        case "openSessions":
          openSessions()
          break
        case "resumeLast":
          resumeMostRecent()
          break
        case "rewindList": {
          const checkpoints = agent.listCheckpoints()
          if (checkpoints.length === 0) {
            dispatch({
              type: "NOTICE",
              message: "No checkpoints yet — they're captured as the agent works.",
            })
            break
          }
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: {
              kind: "select",
              title: "Rewind to checkpoint",
              items: checkpoints.map((c) => {
                const label = c.label.length > 48 ? `${c.label.slice(0, 47)}…` : c.label
                const files = c.fileCount
                  ? ` · ${c.fileCount} file${c.fileCount === 1 ? "" : "s"}`
                  : ""
                return { id: String(c.seq), label: `#${c.seq} · ${label}${files}` }
              }),
              index: 0,
              onSelectCommand: "rewind apply",
            },
          })
          break
        }
        case "rewind":
          void agent.rewind(effect.seq, effect.scope, state.cells)
          break
        case "addDir": {
          const r = computeAddDir(effect.op, effect.arg, {
            config: state.config,
            cwd: state.config.cwd,
            exists: (p) => fs.existsSync(p),
            isDir: (p) => {
              try {
                return fs.statSync(p).isDirectory()
              } catch {
                return false
              }
            },
          })
          if (r.roots) {
            // Persist (best-effort — a read-only home keeps it in-memory only),
            // patch the live config, and re-resolve options so the next turn
            // exposes the new dirs to the Read tool.
            try {
              setAdditionalRoots(home, r.roots)
            } catch {
              // read-only home: in-memory only
            }
            dispatch({ type: "SET_ADDITIONAL_ROOTS", roots: r.roots })
            agent.invalidate()
            // Light up the CwdChanged lifecycle hook (ADR-0040 follow-up): the
            // agent's readable working roots just changed. Fire-and-forget.
            void createCliLifecycleFirer({ home, osHome })(
              "CwdChanged",
              {
                agentId: "cli",
                sessionId: state.sessionId,
              },
              { payload: { roots: r.roots } }
            )
          }
          dispatch({ type: "NOTICE", message: r.message })
          break
        }
        case "runBash":
          runBash(effect.command)
          break
        case "statusBar":
          // Live-apply the footer change, then persist it to config.json so it
          // survives the next launch. A read-only home only loses persistence.
          dispatch({ type: "SET_STATUS_BAR", statusBar: effect.patch })
          try {
            persistStatusBar(home, effect.patch)
          } catch {
            dispatch({ type: "NOTICE", message: "Status bar updated (couldn't save to config)." })
          }
          break
        case "mascot":
          // Live-apply the mascot change, then persist it. A read-only home only
          // loses persistence (the live change still takes effect this session).
          dispatch({ type: "SET_MASCOT", mascot: effect.patch })
          try {
            persistMascot(home, effect.patch)
          } catch {
            dispatch({ type: "NOTICE", message: "Mascot updated (couldn't save to config)." })
          }
          break
        case "theme":
          // Live-apply the colour theme (the reducer re-resolves the palette so
          // the whole UI recolours in place), then persist the scalar key. The
          // theme is display-only, so no SendOptions invalidation is needed.
          dispatch({ type: "SET_THEME", theme: effect.theme })
          if (!persist("theme", effect.theme)) {
            dispatch({ type: "NOTICE", message: "Theme updated (couldn't save to config)." })
          } else {
            dispatch({ type: "NOTICE", message: `Theme: ${effect.theme}` })
          }
          break
        case "outputStyle":
          // Live-apply the response mode, persist it (scalar config key), and
          // re-resolve SendOptions so the next turn uses the new system prompt.
          dispatch({ type: "SET_OUTPUT_STYLE", style: effect.style })
          if (!persist("outputStyle", effect.style)) {
            dispatch({ type: "NOTICE", message: "Output style updated (couldn't save to config)." })
          }
          agent.invalidate()
          dispatch({ type: "NOTICE", message: `Output style: ${effect.style}` })
          break
        case "agentMode":
          // Persist the active mode (scalar config key) and recreate the session
          // (switchAgentMode dispatches SET_AGENT_MODE + drops the session) so the
          // mode's prompt / tools / model / permission take effect next turn.
          if (!persist("agentMode", effect.modeId)) {
            dispatch({ type: "NOTICE", message: "Agent mode updated (couldn't save to config)." })
          }
          void agent.switchAgentMode(effect.modeId)
          dispatch({
            type: "NOTICE",
            message:
              effect.modeId === "general"
                ? "Agent mode: none (plain chat)"
                : `Agent mode: ${effect.modeId}`,
          })
          break
        case "layout":
          // Live-apply the layout (the alt-screen useEffect below enters/exits
          // the alternate buffer as `fullscreen` flips) and persist the scalar
          // key. Display-only, so no SendOptions invalidation. The effective mode
          // still degrades to scrollback on a non-TTY terminal.
          dispatch({ type: "SET_LAYOUT", layout: effect.mode })
          if (!persist("layout", effect.mode)) {
            dispatch({ type: "NOTICE", message: "Layout updated (couldn't save to config)." })
          } else {
            dispatch({ type: "NOTICE", message: `Layout: ${effect.mode}` })
          }
          break
        case "mouse":
          // Live-apply the mouse model by rewriting the terminal tracking /
          // alternate-scroll escapes in place (only meaningful while fullscreen
          // owns the screen; a no-op on a non-TTY). Then persist the scalar key.
          dispatch({ type: "SET_MOUSE", mode: effect.mode })
          if (fullscreen) applyMouseMode(effect.mode, screen)
          if (!persist("mouse", effect.mode)) {
            dispatch({ type: "NOTICE", message: "Mouse mode updated (couldn't save to config)." })
          } else {
            dispatch({
              type: "NOTICE",
              message:
                effect.mode === "select"
                  ? "Mouse: select — drag to select text; PgUp/PgDn to scroll."
                  : "Mouse: scroll — wheel scrolls; Shift+drag to select text.",
            })
          }
          break
        case "customTheme": {
          // Write the user's edited base colours to ~/.cognia/themes/cli.json and
          // activate `custom:cli` (the reducer re-resolves the palette → expandPalette
          // cascades each base edit to every derived token). A read-only home only
          // loses persistence; the live recolour still applies this session.
          const slug = "cli"
          try {
            setCustomTheme(home, slug, {
              base: effect.base,
              ...(effect.overrides ? { overrides: effect.overrides } : {}),
            })
            setConfigValue(home, "theme", `custom:${slug}`)
          } catch {
            dispatch({ type: "NOTICE", message: "Custom theme applied (couldn't save to config)." })
          }
          dispatch({ type: "SET_THEME", theme: `custom:${slug}` })
          dispatch({ type: "NOTICE", message: "Applied your custom theme." })
          break
        }
        case "settingsSet": {
          // Apply a previously file-only field edited from the settings panel's
          // single-field form (system prompt / skill dirs / allowed-tools list).
          const field = effect.field
          let patch: Partial<ResolvedConfig> = {}
          try {
            if (field === "systemPrompt") {
              patch = { systemPrompt: effect.value || undefined }
              setConfigValue(home, "systemPrompt", effect.value)
            } else if (field === "skillDirs" || field === "allowedTools") {
              const arr = effect.value.split(/\s+/).filter(Boolean)
              patch = { [field]: arr.length ? arr : undefined } as Partial<ResolvedConfig>
              setStringArrayConfig(home, field, arr)
            }
          } catch {
            dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
          }
          dispatch({ type: "SET_CONFIG_PATCH", patch })
          agent.invalidate()
          dispatch({ type: "NOTICE", message: `Updated ${field}.` })
          break
        }
        case "keybind": {
          // Rebind (spec) or reset (empty spec) a keyboard chord. Persisted to
          // config.keybindings and live-merged so the next keypress honours it.
          const action = effect.action
          try {
            if (effect.spec === "") {
              setKeybindings(home, { [action]: null })
              const next = { ...state.config.keybindings }
              delete next[action]
              dispatch({ type: "SET_CONFIG_PATCH", patch: { keybindings: next } })
              dispatch({ type: "NOTICE", message: `Reset ${action} to its default key.` })
            } else {
              setKeybindings(home, { [action]: effect.spec })
              dispatch({
                type: "SET_CONFIG_PATCH",
                patch: { keybindings: { ...state.config.keybindings, [action]: effect.spec } },
              })
              dispatch({ type: "NOTICE", message: `Bound ${action} to ${effect.spec}.` })
            }
          } catch {
            dispatch({ type: "NOTICE", message: "Keybinding changed (couldn't save to config)." })
          }
          break
        }
        case "goalRun": {
          // Start a self-driving goal that streams every turn into the transcript
          // (reuses lib/goal: createGoal + judge + handleTurnComplete). Esc aborts
          // the controller, ending the run. `btw` steers it via `takeSteer`.
          const controller = new AbortController()
          runtimeAbort.current = controller
          void startGoalRun(effect.objective, {
            send: agent.send,
            dispatch,
            sessionId: state.sessionId,
            config: state.config,
            signal: controller.signal,
            takeSteer,
            firer: createCliLifecycleFirer({ home, osHome }),
          }).finally(() => {
            if (runtimeAbort.current === controller) runtimeAbort.current = null
            persistDb()
          })
          break
        }
        case "loop": {
          // Run a self-paced or interval loop, streaming each turn (reuses
          // lib/loop). Esc aborts the controller; `btw` steers via `takeSteer`.
          const controller = new AbortController()
          runtimeAbort.current = controller
          void startLoopRun({
            send: agent.send,
            dispatch,
            sessionId: state.sessionId,
            config: state.config,
            signal: controller.signal,
            mode: effect.mode,
            prompt: effect.prompt,
            ...(effect.intervalMs !== undefined ? { intervalMs: effect.intervalMs } : {}),
            ...(effect.maxIterations !== undefined ? { maxIterations: effect.maxIterations } : {}),
            takeSteer,
          }).finally(() => {
            if (runtimeAbort.current === controller) runtimeAbort.current = null
            persistDb()
          })
          break
        }
        case "runtime": {
          const controller = new AbortController()
          runtimeAbort.current = controller
          const roots = [state.config.cwd, home]
          void runRuntimeRequest(effect.runtime, {
            dispatch,
            config: state.config,
            sessionId: state.sessionId,
            signal: controller.signal,
            home,
            osHome,
            roots,
            version: VERSION,
            usage: state.usage,
            contextWindow: state.modelMeta?.contextWindow,
            usageHistory: state.usageHistory,
            toolStats: state.toolStats,
            ...(state.rateLimits ? { rateLimits: state.rateLimits } : {}),
            ...(state.initDraft ? { initDraft: state.initDraft } : {}),
            inflightTools: state.inflight.tools,
          })
            .catch((err: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Runtime error: ${err instanceof Error ? err.message : String(err)}`,
              })
            )
            .finally(() => {
              if (runtimeAbort.current === controller) runtimeAbort.current = null
              // Config-mutating features (MCP / skill / plugin toggles) must
              // re-resolve SendOptions so the change reaches the next turn.
              if (
                effect.runtime.feature === "mcp" ||
                effect.runtime.feature === "skill" ||
                effect.runtime.feature === "plugin" ||
                effect.runtime.feature === "permissions"
              ) {
                agent.invalidate()
              }
              // Persist any db writes the runtime performed.
              persistDb()
            })
          break
        }
        case "planRefine":
          // Drop back into plan mode (persist + live) and seed a revise turn —
          // the OpenCode "keep iterating" loop. Mirrors the plan-approval switch:
          // switchMode mutates the live session in place, so the plan above is
          // still in context for the refine turn.
          persist("permissionMode", "plan")
          void (async () => {
            await agent.switchMode("plan")
            await agent.send(PLAN_REFINE_PROMPT)
          })()
          break
        case "exit":
          doExit()
          break
      }
    },
    [
      agent,
      clearScreen,
      copyClipboard,
      doExit,
      home,
      osHome,
      mintId,
      openSessions,
      persist,
      persistDb,
      persistStatusBar,
      persistMascot,
      pushHandoff,
      resumeMostRecent,
      runBash,
      startGoalRun,
      startLoopRun,
      takeSteer,
      scrollReset,
      cursor,
      fullscreen,
      screen,
      notices,
      state.config,
      state.sessionId,
      state.usage,
      state.modelMeta,
      state.usageHistory,
      state.toolStats,
      state.rateLimits,
      state.initDraft,
      state.cells,
    ]
  )

  const runCommandLine = useCallback(
    (line: string) => {
      applyEffect(
        dispatchCommand(line, { state, config: state.config, version: VERSION, args: "" })
      )
    },
    [applyEffect, state]
  )

  // Resolve `@skill:` / `@agent:` mentions in a submitted line before it is sent:
  // enable + persist mentioned skills, synchronously dispatch mentioned agents and
  // fold their output into the prompt, and strip the tokens. Reuses the same
  // skill/agent discovery the `/skill` + `/agents` controllers use. Returns the
  // rewritten prompt and the ids of any skills enabled (so the caller can
  // invalidate the cached SendOptions for the next turn).
  const runMentionPreprocess = useCallback(
    (text: string) =>
      preprocessMentions(text, {
        setSkillEnabled: (id) => {
          if (persistSkillEnabled) {
            persistSkillEnabled(id)
            return
          }
          skillSetEnabled(id, true, {
            dispatch,
            home,
            cwd: state.config.cwd,
            osHome,
            externalSkills: state.config.externalSkills,
            skillDirs: state.config.skillDirs,
          })
        },
        dispatchAgent: async (id, prompt) => {
          const agents = buildAgents(await discoverAgentFiles([state.config.cwd, home]))
          const match = agents.find((a) => a.id === id)
          if (!match) return { text: `subagent "${id}" not found`, ok: false }
          dispatch({
            type: "ACTIVITY_START",
            kind: "agent",
            label: `${id}: ${prompt}`.slice(0, 60),
          })
          try {
            const result = await dispatchSubagent(match.def, prompt, { cwd: state.config.cwd })
            dispatch({ type: "ACTIVITY_END", status: "done", summary: `Subagent "${id}" done` })
            return { text: result.text, ok: true }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            dispatch({ type: "ACTIVITY_END", status: "error", summary: `Subagent "${id}" failed` })
            return { text: message, ok: false }
          }
        },
        notice: (message) => dispatch({ type: "NOTICE", message }),
        // Map every accepted `@skill:` token (the friendly slug the popup inserts
        // AND the raw id, for back-compat) to the real Dexie id to enable.
        skillIdsByToken: async () => {
          const map = new Map<string, string>()
          for (const c of await mentionProviders.skills("")) {
            if (c.slug) map.set(c.slug, c.id)
            map.set(c.id, c.id)
          }
          return map
        },
        knownAgentIds: async () => new Set((await mentionProviders.agents("")).map((c) => c.id)),
      }),
    [
      mentionProviders,
      home,
      osHome,
      state.config.cwd,
      state.config.externalSkills,
      state.config.skillDirs,
      persistSkillEnabled,
    ]
  )

  // Send a plain message, then deliver any `btw` steer typed while it streamed
  // as follow-up turns — so a steer never interrupts the turn it was typed
  // during. Stops if a goal/loop run takes over (that driver owns the drain).
  const sendThenDrainSteer = useCallback(
    async (text: string) => {
      // Resolve @-mentions first: enable skills, run agents, rewrite the prompt.
      const { prompt, enabledSkills } = await runMentionPreprocess(text)
      // A newly-enabled skill must take effect next turn — drop the cached
      // SendOptions so they re-resolve with the updated ephemeralSkillIds.
      if (enabledSkills.length > 0) agent.invalidate()
      await agent.send(prompt)
      let steer = takeSteer()
      while (steer !== null && runtimeAbort.current === null) {
        await agent.send(frameSteer(steer))
        steer = takeSteer()
      }
    },
    [agent, takeSteer, runMentionPreprocess]
  )

  // In copilot mode a plain message goes to the workflow-editor session; after
  // the turn, surface any newly-staged proposal as an Apply/Discard overlay.
  const sendCopilot = useCallback(
    async (workflowId: string, text: string) => {
      await agent.send(text)
      copilotCheckProposal(workflowId, { dispatch })
    },
    [agent]
  )

  const handleSubmit = useCallback(
    (text: string) => {
      // Re-pin the fullscreen viewport to the bottom on any submit, so sending a
      // message always snaps back to the live turn even if the user had scrolled
      // up to read history. No-op in scrollback mode.
      scrollReset()
      // Editing a prior message: fork the conversation at the target (drop it and
      // every later turn), then send the edited text as a fresh turn. Only a plain
      // message edits — submitting a `/command` or `!bash` instead abandons the
      // pending edit (clear the target so its stale index can't fork a later send).
      const editTarget = state.editTarget
      if (editTarget) {
        if (!text.startsWith("/") && parseBang(text) === null) {
          const cells = state.cells
          void (async () => {
            await agent.forkConversationAt(editTarget.index, cells)
            dispatch({
              type: "NOTICE",
              message:
                "Edited and re-ran from here. Earlier file changes were not reverted — use /rewind both to restore.",
            })
            await sendThenDrainSteer(text)
          })()
          return
        }
        dispatch({ type: "EDIT_CLEAR" })
      }
      const bang = parseBang(text)
      if (bang !== null) {
        runBash(bang)
        return
      }
      if (!text.startsWith("/")) {
        // A message typed while a turn or a goal/loop run is in flight becomes a
        // `btw` steer: queued and delivered at the next turn boundary so it never
        // interrupts the running turn.
        if (busy || runtimeAbort.current !== null) {
          dispatch({ type: "STEER_ENQUEUE", text })
          dispatch({
            type: "NOTICE",
            message: "💬 Queued (btw) — will steer the run at the next turn boundary.",
          })
          return
        }
        // Copilot mode routes free-text to the workflow-editor session.
        const copilotWf = state.copilot?.workflowId
        if (copilotWf) {
          void sendCopilot(copilotWf, text)
          return
        }
        void sendThenDrainSteer(text)
        return
      }
      runCommandLine(text)
    },
    [
      busy,
      runBash,
      runCommandLine,
      sendThenDrainSteer,
      sendCopilot,
      state.copilot?.workflowId,
      state.editTarget,
      state.cells,
      agent,
      scrollReset,
    ]
  )

  const submitForm = useCallback(() => {
    if (state.overlay.kind !== "form") return
    const form = state.overlay.form
    const result = formSubmit(form)
    if (!result.ok) {
      dispatch({ type: "FORM_UPDATE", form: result.form })
      return
    }
    dispatch({ type: "OVERLAY_CLOSE" })
    const sub = form.subcommand ? ` ${form.subcommand}` : ""
    runCommandLine(`/${form.commandName}${sub} ${result.args}`.trim())
  }, [state.overlay, runCommandLine])

  // Apply an inline settings-panel edit (enum cycle / boolean toggle): persist
  // via the matching mutate helper, live-merge the config, then RE-OPEN the panel
  // so the new value shows immediately (the panel snapshot is rebuilt from the
  // post-edit config). Nested objects are pre-merged here so SET_CONFIG_PATCH can
  // stay a shallow merge. Tool/flag/hook/output edits invalidate the cached
  // SendOptions so the next turn picks them up; theme/mascot are display-only.
  const applySettings = useCallback(
    (target: SettingsApplyTarget, value: string | boolean) => {
      const cfg = state.config
      let patch: Partial<ResolvedConfig> = {}
      let invalidate = false
      try {
        switch (target.kind) {
          case "theme":
            patch = { theme: String(value) }
            setConfigValue(home, "theme", String(value))
            break
          case "outputStyle":
            patch = { outputStyle: value as OutputStyle }
            setConfigValue(home, "outputStyle", String(value))
            invalidate = true
            break
          case "statusTheme":
            patch = { statusBar: { ...cfg.statusBar, theme: value as StatusTheme } }
            setStatusBarConfig(home, { theme: value as StatusTheme })
            break
          case "mascotEnabled":
            patch = { mascot: { ...cfg.mascot, enabled: Boolean(value) } }
            setMascotConfig(home, { enabled: Boolean(value) })
            break
          case "mascotStyle":
            patch = { mascot: { ...cfg.mascot, style: value as MascotStyle } }
            setMascotConfig(home, { style: value as MascotStyle })
            break
          case "flag":
            patch = { [target.key]: Boolean(value) } as Partial<ResolvedConfig>
            setBooleanFlag(home, target.key, Boolean(value))
            invalidate = true
            break
          case "configValue":
            patch = { [target.key]: String(value) } as Partial<ResolvedConfig>
            setConfigValue(home, target.key, String(value))
            invalidate = true
            break
          case "builtinTool":
            patch = { builtinTools: { ...cfg.builtinTools, [target.key]: Boolean(value) } }
            setBuiltinTools(home, { [target.key]: Boolean(value) } as Partial<BuiltinToolsConfig>)
            invalidate = true
            break
          case "hook":
            patch = {
              builtinHookOverrides: { ...cfg.builtinHookOverrides, [target.id]: Boolean(value) },
            }
            setBuiltinHookOverride(home, target.id, Boolean(value))
            invalidate = true
            break
          case "render": {
            // Numeric prefs arrive as a string from an enum row; booleans as a
            // boolean from a toggle. Display-only — no SendOptions invalidation.
            const rawValue = NUMERIC_RENDER_KEYS.has(target.key) ? Number(value) : Boolean(value)
            patch = { render: { ...cfg.render, [target.key]: rawValue } }
            setRenderConfig(home, { [target.key]: rawValue })
            break
          }
        }
      } catch {
        dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
      }
      dispatch({ type: "SET_CONFIG_PATCH", patch })
      if (invalidate) agent.invalidate()
      const ov = state.overlay
      const section = ov.kind === "settings" ? ov.section : 0
      const index = ov.kind === "settings" ? ov.index : 0
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "settings",
          sections: settingsSections({ ...cfg, ...patch }),
          section,
          index,
        },
      })
    },
    [state.config, state.overlay, home, agent]
  )

  // Enter on a delegate/form settings row: delegate rows run the existing slash
  // command (opening its overlay); form rows open a single-/multi-field editor.
  const activateSettings = useCallback(
    (row: SettingsRow) => {
      const c = row.control
      if (c.type === "delegate") {
        runCommandLine(c.command)
        return
      }
      if (c.type !== "form") return
      if (c.field === "customTheme") {
        runCommandLine("/theme custom")
        return
      }
      const cfg = state.config
      let current = ""
      if (c.field === "systemPrompt") current = cfg.systemPrompt ?? ""
      else if (c.field === "skillDirs") current = (cfg.skillDirs ?? []).join(" ")
      else if (c.field === "allowedTools") current = (cfg.allowedTools ?? []).join(" ")
      applyEffect({
        kind: "openForm",
        form: {
          title: `Edit ${c.field}`,
          commandName: "settings",
          subcommand: c.field,
          specs: [
            {
              name: "value",
              label: c.field,
              type: "string",
              style: "positional",
              default: current,
            },
          ],
        },
      })
    },
    [state.config, runCommandLine, applyEffect]
  )

  // `/agents models` panel edit: persist one subagent's provider/model override
  // (or clear it on `null`), patch the live config, invalidate the session so the
  // next dispatch picks up the change, and reopen the panel with rows recomputed
  // against the new config (cursor index preserved). Mirrors `applySettings`.
  const applySubagentModelEdit = useCallback(
    (agentId: string, override: SubagentModelOverride | null) => {
      const ov = state.overlay
      if (ov.kind !== "subagentModels") return
      const nextMap = { ...(state.config.subagentModels ?? {}) }
      if (override === null) delete nextMap[agentId]
      else nextMap[agentId] = override
      const subagentModels = Object.keys(nextMap).length > 0 ? nextMap : undefined
      const patch: Partial<ResolvedConfig> = { subagentModels }
      try {
        setSubagentModel(home, agentId, override)
      } catch {
        dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
      }
      dispatch({ type: "SET_CONFIG_PATCH", patch })
      agent.invalidate()
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "subagentModels",
          rows: recomputeSubagentModelRows(ov.rows, { ...state.config, ...patch }),
          index: ov.index,
        },
      })
    },
    [state.overlay, state.config, home, agent]
  )

  // Reverse-history-search handlers. The pure `searchHistory` matcher scans the
  // composer history (oldest-first); `fromIndex = entries.length` finds the most
  // recent match, and passing the last hit's index cycles to the next-older one.
  // Refining the query always restarts from the most-recent end.
  const applyHistorySearch = useCallback(
    (query: string, fromIndex: number) => {
      const hit = searchHistory(state.input.history.entries, query, fromIndex)
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "historySearch",
          query,
          match: hit ? hit.match : null,
          // Keep the cursor where it was so a no-match Ctrl+R doesn't reset the
          // cycle to the top; on a hit, advance to the hit so the next Ctrl+R
          // continues older.
          matchIndex: hit ? hit.index : fromIndex,
        },
      })
    },
    [state.input.history.entries]
  )

  // Ctrl+V: read an image off the OS clipboard and append it as an `@<path>`
  // mention into the composer, so it flows through the existing attachment
  // pipeline (the same `@file` mechanism a typed path uses). A missing image
  // surfaces a notice rather than failing silently.
  const pasteClipboardImage = useCallback(async () => {
    const result = await readClipboardImage()
    if (!result) {
      dispatch({ type: "NOTICE", message: "No image in clipboard" })
      return
    }
    const buffer = state.input.buffer
    const sep = bufferText(buffer).length > 0 ? " " : ""
    dispatch({ type: "INPUT_SET", buffer: insertText(buffer, `${sep}@${result.path}`) })
    dispatch({ type: "NOTICE", message: "📎 image from clipboard" })
  }, [readClipboardImage, state.input.buffer])

  const abortRuntime = useCallback(() => {
    if (runtimeAbort.current) {
      runtimeAbort.current.abort()
      runtimeAbort.current = null
    }
  }, [])

  // Resolve a permission prompt. On "Allow always", persist the tool so it never
  // prompts again (the desktop's always-allow store, ported to the CLI) and
  // invalidate the cached SendOptions so the next turn re-resolves with it.
  const resolvePermission = useCallback(
    (decision: CapturePermissionDecision) => {
      if (decision.decision === "allow_always" && state.overlay.kind === "permission") {
        const toolName = state.overlay.req.toolName
        try {
          persistToolApproval(home, toolName)
        } catch {
          // best-effort — a read-only home shouldn't break the turn.
        }
        // Add to the live set so later calls THIS session auto-approve silently
        // (invalidate only re-resolves options on the NEXT session respawn, so
        // without this the same tool keeps prompting for the rest of the turn).
        agent.rememberApproval(toolName)
        agent.invalidate()
      }
      agent.resolvePermission(decision)
    },
    [agent, home, persistToolApproval, state.overlay]
  )

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // A Ctrl+C with draft text in the composer clears the draft first (Claude
      // Code behaviour) — it never interrupts the turn or counts toward exit.
      // Only an empty composer falls through to the interrupt / double-press-to-
      // exit ladder below. Guarded to the normal chat view: overlays own their
      // own keys and the startup gate handles its own input.
      if (state.phase === "chat" && !overlayOpen && bufferText(state.input.buffer).length > 0) {
        dispatch({ type: "INPUT_CLEAR" })
        // Cancel any half-armed "press again to exit" window so the cleared
        // draft doesn't leave a primed exit behind.
        if (ctrlCTimer.current) {
          clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = null
        }
        if (state.lastCtrlCAt) dispatch({ type: "CLEAR_CTRL_C" })
        return
      }
      const at = now()
      if (state.lastCtrlCAt && at - state.lastCtrlCAt < DOUBLE_CTRL_C_MS) {
        // Clear the pending hint timer before we exit.
        if (ctrlCTimer.current) {
          clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = null
        }
        doExit()
      } else {
        dispatch({ type: "CTRL_C", at })
        if (busy) {
          agent.abort()
          abortRuntime()
          // A turn-blocking overlay (permission prompt / ask_user question) would
          // otherwise linger after the abort with an orphaned resolver. Close the
          // permission overlay; settle ask_user as cancelled so its store doesn't
          // immediately re-open it (the bridge re-fires on an unresolved prompt).
          if (state.overlay.kind === "permission") dispatch({ type: "OVERLAY_CLOSE" })
          else if (state.overlay.kind === "askUser")
            askUser.resolve({ selected: [], text: "", cancelled: true })
          dispatch({ type: "NOTICE", message: "Interrupted · Press Ctrl+C again to exit" })
        } else {
          dispatch({ type: "NOTICE", message: "Press Ctrl+C again to exit" })
        }
        // Clear the double-press window after 3 s so a single press doesn't
        // linger indefinitely — the next Ctrl+C restarts the cycle.
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current)
        ctrlCTimer.current = setTimeout(() => {
          ctrlCTimer.current = null
          dispatch({ type: "CLEAR_CTRL_C" })
        }, 3000)
      }
      return
    }
    // During the startup gate, only Ctrl+C (above) is honored — the gate owns
    // its own keys.
    if (state.phase === "startup") return
    // Find-in-viewport (Ctrl+F): while the find bar is open it owns all input —
    // printable keys extend the query (live incremental search), arrows / Enter
    // step matches, Ctrl+Y copies the focused match, Esc closes. The composer is
    // unmounted during find (see the render below), so this is the only consumer.
    if (cursor.state.find) {
      const find = cursor.state.find
      if (key.escape) {
        cursor.clear()
        clearScreen()
        return
      }
      if (key.return || key.downArrow) {
        cursor.next()
        return
      }
      if (key.upArrow) {
        cursor.prev()
        return
      }
      if (key.ctrl && input === "y") {
        const cell = cursor.focused
        if (cell) {
          void Promise.resolve(copyClipboard(cellToText(cell))).then((res) =>
            dispatch({
              type: "NOTICE",
              message: res.ok ? notices.copiedCell : clipboardFailureMessage(res.reason, notices),
            })
          )
        }
        return
      }
      if (key.backspace || key.delete) {
        cursor.setQuery(find.query.slice(0, -1))
        return
      }
      // A printable character extends the query; control/meta chords are ignored.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        cursor.setQuery(find.query + input)
        return
      }
      return
    }
    // Backtrack-to-edit selection: the composer is inert (`disabled` below) while
    // a prior user message is highlighted. ↑/↓ walk between user messages, Esc
    // cancels, Enter (or typing) loads the message into the composer as the edit
    // target — submitting then forks the conversation there.
    if (state.backtrack) {
      const idx = state.backtrack.index
      const targetText = () => {
        const cell = state.cells[idx]
        return cell && cell.kind === "user" ? cell.text : ""
      }
      // Scrollback highlights via `<Static>`, which only repaints after a clear +
      // epoch bump. Wipe the screen here so the reducer's epoch bump re-prints the
      // transcript with the highlight at its new position. Fullscreen re-renders
      // live, so it needs no clear.
      const repaintHighlight = () => {
        if (!fullscreen) clearScreen()
      }
      if (key.upArrow) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_MOVE", dir: -1 })
        return
      }
      if (key.downArrow) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_MOVE", dir: 1 })
        return
      }
      if (key.escape) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_CANCEL" })
        return
      }
      if (key.return) {
        repaintHighlight()
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(targetText()) })
        dispatch({ type: "BACKTRACK_COMMIT", index: idx })
        return
      }
      // Start typing to edit: load the message and append the typed character.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        repaintHighlight()
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(targetText() + input) })
        dispatch({ type: "BACKTRACK_COMMIT", index: idx })
        return
      }
      return
    }
    // Fullscreen scroll: PgUp/PgDn page the transcript viewport (conflict-free —
    // the composer ignores PageUp/PageDown, and overlays own input while open).
    // Reaching the bottom re-engages follow mode, so PgDn doubles as "jump to
    // latest". In scrollback mode the terminal's native scrollback handles this,
    // so these keys fall through untouched.
    if (fullscreen && !overlayOpen) {
      if (key.pageUp) {
        scroll.pageUp()
        return
      }
      if (key.pageDown) {
        scroll.pageDown()
        return
      }
      // Mouse reports only arrive in `scroll` mode (SGR tracking is on). Scroll
      // the transcript by a few lines per wheel notch; swallow every other mouse
      // event (clicks/releases) so it never reaches a text field as literal
      // characters. In `select` mode tracking is off, so any stray report is
      // still swallowed here rather than inserted.
      const mouse = parseMouseEvent(input)
      if (mouse) {
        // While the composer popup owns input, let it consume the wheel (it
        // scrolls the popup) instead of paging the transcript underneath.
        if (mouse.kind === "wheel" && mouseMode === "scroll" && !composerPopupOpen.current) {
          for (let i = 0; i < WHEEL_SCROLL_LINES; i++) {
            if (mouse.dir === "up") scroll.lineUp()
            else scroll.lineDown()
          }
        } else if (mouse.kind === "click") {
          // A click on the BottomStatus subagent chip opens the `/agents` panel
          // (parity with Ctrl+B). Only acts when an agent chip is actually shown
          // and the click lands on its row.
          const hasAgentChip =
            runningSubagents(state.inflight.tools) != null ||
            countRunningCliBackgroundRuns(state.sessionId) > 0
          if (hasAgentChip && subagentChipRef.current) {
            const pos = absoluteTopLeft(subagentChipRef.current)
            if (pos) {
              const height = measureElement(subagentChipRef.current).height || 1
              const clickRow = mouse.row - 1
              if (clickRow >= pos.top && clickRow < pos.top + height) runCommandLine("/agents")
            }
          }
        }
        return
      }
    }
    // Ctrl+T toggles tool/thinking output for the whole transcript (moved off
    // Ctrl+R, which now opens history search). The composer ignores unhandled
    // ctrl chords, and overlays own input while open, so this only fires in the
    // normal chat view. The transcript lives in `<Static>` (write-once), so clear
    // the screen and let the bumped epoch re-print every cell with the new
    // collapsed state.
    // Global chord actions are resolved through the (customizable) keybindings
    // table — see `input/keybindings.ts`. Each keeps its own guard; all are gated
    // on no-overlay so a modal owns input while open. Defaults reproduce the
    // historic chords (Ctrl+T/R/O/V/I) plus the new Ctrl+G inspector.
    const chord = overlayOpen ? undefined : matchAction(keybindings, input, key)
    // Toggle tool/thinking output for the whole transcript. The transcript lives
    // in `<Static>` (write-once), so clear the screen and let the bumped epoch
    // re-print every cell with the new collapsed state.
    if (chord === "collapseAll") {
      clearScreen()
      dispatch({ type: "TOGGLE_COLLAPSE_ALL" })
      return
    }
    // Open incremental find-in-viewport. Fullscreen only: the jump-to-match needs
    // the app-managed scroll viewport (scrollback mode has `/search` instead).
    if (chord === "find") {
      if (fullscreen) cursor.open()
      else dispatch({ type: "NOTICE", message: "Find is available in the fullscreen layout." })
      return
    }
    // Reverse-history-search over the composer history (readline parity). The
    // overlay owns input once open; here we seed it empty with no match yet.
    if (chord === "historySearch") {
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "historySearch",
          query: "",
          match: null,
          matchIndex: state.input.history.entries.length,
        },
      })
      return
    }
    // Persistent detailed-output mode (Claude Code parity): all tool/thinking
    // cells render expanded until toggled off. Same write-once repaint dance.
    if (chord === "verboseToggle") {
      clearScreen()
      dispatch({ type: "TOGGLE_VERBOSE" })
      dispatch({ type: "NOTICE", message: state.verbose ? "Detail mode off" : "Detail mode on" })
      return
    }
    // Open the tool-output inspector: a picker of every tool/bash/subagent cell
    // that produced output; Enter opens its full, highlighted output in the pager.
    if (chord === "inspect") {
      const items = collectInspectables(state.cells)
      if (items.length === 0) {
        dispatch({ type: "NOTICE", message: "No tool output to inspect yet." })
      } else {
        dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "inspect", items, index: 0 } })
      }
      return
    }
    // Open the running-agents panel: in-turn sub-agent dispatches + background
    // runs. Routes through the command pipeline so the runtime dispatcher (which
    // carries the live in-flight tools) builds the rows.
    if (chord === "agentsPanel") {
      runCommandLine("/agents")
      return
    }
    // Copy the latest assistant reply to the clipboard without entering find
    // mode (Codex Ctrl+O parity). The injected writer handles OSC 52 over SSH.
    if (chord === "copyLast") {
      const reply = lastAssistantText(state)
      if (reply) {
        void Promise.resolve(copyClipboard(reply)).then((res) =>
          dispatch({
            type: "NOTICE",
            message: res.ok ? notices.copiedReply : clipboardFailureMessage(res.reason, notices),
          })
        )
      } else {
        dispatch({ type: "NOTICE", message: notices.noReplyToCopy })
      }
      return
    }
    // Clear the visible scrollback + repaint WITHOUT resetting the conversation
    // (distinct from `/clear`, which wipes the session). Cells are untouched.
    if (chord === "clearScreen") {
      clearScreen()
      scrollReset()
      cursor.clear()
      dispatch({ type: "REPAINT" })
      return
    }
    // Paste an image from the OS clipboard as an `@<path>` mention so it flows
    // through the attachment pipeline.
    if (chord === "pasteImage") {
      void pasteClipboardImage()
      return
    }
    // Inspect the current step of a live `/workflow run` — input/output/logs/usage
    // in a scrollable document overlay (reuses the `document` kind). Only fires
    // when a run is actually in flight.
    if (chord === "workflowInspect" && state.workflowRun?.steps.length) {
      const wr = state.workflowRun
      const sel = wr.currentId
        ? wr.steps.find((s) => s.id === wr.currentId)
        : wr.steps[Math.min(wr.completed, wr.steps.length - 1)]
      if (sel) {
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: `Step · ${sel.label}`,
            body: buildStepInspectorDoc(sel, wr.events ?? []),
            format: "markdown",
          },
        })
      }
      return
    }
    // Shift+Tab cycles the permission mode (Claude Code parity). Persists the
    // choice and re-resolves SendOptions via switchMode so the next turn honours
    // it. Gated on no-overlay so a completion popup's Tab keeps priority.
    if (key.tab && key.shift && !overlayOpen) {
      const next = cyclePermissionMode(state.config.permissionMode)
      persist("permissionMode", next)
      void agent.switchMode(next)
      dispatch({ type: "NOTICE", message: `Permission mode: ${next}` })
      return
    }
    // Esc only acts here when no overlay is open (overlays own their Esc).
    if (key.escape && !overlayOpen) {
      // A live turn / background run: Esc interrupts (existing behaviour) and
      // cancels any half-armed backtrack.
      if (busy || state.activity) {
        if (busy) agent.abort()
        abortRuntime()
        disarmBacktrack()
        return
      }
      // Idle: double-Esc enters backtrack-to-edit selection. Skip while the
      // completion popup is open (its Esc closes the popup) or while the composer
      // holds a draft (don't clobber unsent text). The selection highlights the
      // last user message; ↑/↓ walk earlier/later, Enter loads it for editing.
      if (composerPopupOpen.current) return
      // Esc while editing a backtracked message cancels: drop the edit target and
      // clear the composer (the loaded text is discarded).
      if (state.editTarget) {
        dispatch({ type: "EDIT_CLEAR" })
        dispatch({ type: "INPUT_SET", buffer: bufferFromText("") })
        disarmBacktrack()
        return
      }
      if (bufferText(state.input.buffer).length > 0) {
        disarmBacktrack()
        return
      }
      if (backtrackArmedRef.current) {
        disarmBacktrack()
        // Scrollback: clear so the epoch bump re-prints with the new highlight.
        if (!fullscreen) clearScreen()
        dispatch({ type: "BACKTRACK_ENTER" })
      } else {
        armBacktrack()
      }
    }
  })

  const banner = useMemo(
    () => (
      <Banner
        version={VERSION}
        provider={state.config.provider}
        model={activeModel}
        cwd={state.config.cwd}
      />
    ),
    [activeModel, state.config.cwd, state.config.provider]
  )
  const lastPlanRaw = state.lastPlan?.raw
  const footerPlanTitle = useMemo(
    () => (lastPlanRaw ? planTitle(lastPlanRaw) : undefined),
    [lastPlanRaw]
  )
  const inflightTools = state.inflight.tools
  const footerSubagentRunning = useMemo(() => runningSubagents(inflightTools), [inflightTools])
  const footerBackgroundSubagents = useMemo(() => {
    void inflightTools
    // Scope to this chat session so the footer counts only the background
    // subagents the current session started (the registry is process-global).
    return countRunningCliBackgroundRuns(state.sessionId)
  }, [inflightTools, state.sessionId])
  const copilotName = state.copilot?.name
  const hasCopilot = state.copilot !== undefined
  const footerCopilot = useMemo(
    () => (hasCopilot ? { name: copilotName ?? "" } : undefined),
    [copilotName, hasCopilot]
  )
  // Timestamp the current turn entered "streaming", for the BottomStatus elapsed
  // timer. Captured in an effect — Date.now() is impure and refs/state must not
  // be touched during render. The deferred set keeps it out of the synchronous
  // effect body; one tick of lag before `since` lands is invisible to the
  // 1s-resolution elapsed timer (BottomStatus renders no elapsed while null).
  const isStreaming = state.turnStatus === "streaming"
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setStreamStartedAt(isStreaming ? Date.now() : null), 0)
    return () => clearTimeout(t)
  }, [isStreaming])

  // Timestamp the last live stream delta, for the BottomStatus stall hint. The
  // reducer bumps `streamSeq` on every text/thinking/tool/usage delta; this
  // effect re-stamps "now" whenever it changes while streaming (mirrors the
  // `since` capture above — deferred set, no impure work during render).
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setLastActivityAt(isStreaming ? Date.now() : null), 0)
    return () => clearTimeout(t)
  }, [isStreaming, state.streamSeq])

  // Startup phase: welcome banner + the "do you trust this folder?" gate only —
  // no transcript/composer/footer until the user proceeds.
  if (state.phase === "startup") {
    return (
      <ThemeProvider palette={themePalette}>
        <RenderPrefsProvider prefs={renderPrefs}>
          <Box flexDirection="column" width={columns}>
            {banner}
            <StartupGate
              cwd={state.config.cwd}
              onTrust={trustCwd}
              onChangeCwd={changeCwd}
              listDirs={listDirs}
              width={columns}
              maxRows={overlayRows}
            />
          </Box>
        </RenderPrefsProvider>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider palette={themePalette}>
      <RenderPrefsProvider prefs={renderPrefs}>
        <Box flexDirection="column" width={columns} {...(fullscreen ? { height: rows } : {})}>
          {fullscreen ? (
            <>
              {/* Fixed top banner — rendered outside the scroll viewport so it
                  never scrolls away (the whole point of fullscreen). It carries a
                  live status line (mode / context / tokens) since, unlike the
                  scrollback banner, it stays on screen for the whole session. */}
              <Banner
                version={VERSION}
                provider={state.config.provider}
                model={activeModel}
                cwd={state.config.cwd}
                status={{
                  mode: state.config.permissionMode,
                  contextPct: contextPercent(
                    state.usage,
                    activeModel,
                    state.modelMeta?.contextWindow
                  ),
                  sessionTokens: state.sessionTotals.inputTokens + state.sessionTotals.outputTokens,
                }}
              />
              {/* Scrollable middle: history + the live turn, clipped to the
                  space between the banner and the composer. */}
              <ScrollView offset={scroll.offset} onMeasure={scroll.measure}>
                <Transcript
                  cells={state.cells}
                  verbose={state.verbose}
                  mode="live"
                  measuring={cursor.measuring}
                  focusedCellId={
                    (state.backtrack ? state.cells[state.backtrack.index]?.id : undefined) ??
                    cursor.state.focusedCellId
                  }
                  onCellHeight={cursor.reportCellHeight}
                />
                <Inflight inflight={state.inflight} verbose={state.verbose} />
                <WorkflowRunPanel run={state.workflowRun} />
              </ScrollView>
              {/* "Scrolled up" hint — only while the view isn't pinned to the
                  bottom, so a following transcript shows nothing. */}
              {!scroll.atBottom && (
                <Box flexShrink={0}>
                  <Text color={themePalette.muted} dimColor>
                    {`↑ ${scroll.hidden.below} more line${scroll.hidden.below === 1 ? "" : "s"} below · End to jump to latest`}
                  </Text>
                </Box>
              )}
            </>
          ) : (
            <>
              <Transcript
                cells={state.cells}
                header={banner}
                verbose={state.verbose}
                epoch={state.renderEpoch}
                focusedCellId={
                  state.backtrack ? (state.cells[state.backtrack.index]?.id ?? null) : null
                }
              />
              <Inflight inflight={state.inflight} verbose={state.verbose} />
              <WorkflowRunPanel run={state.workflowRun} />
            </>
          )}
          {state.overlay.kind === "permission" && (
            <PermissionOverlay
              req={state.overlay.req}
              choices={state.overlay.choices}
              index={state.overlay.index}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onResolve={resolvePermission}
            />
          )}
          {state.overlay.kind === "model" && (
            <SelectList
              title="Switch model"
              items={state.overlay.options.map((m) => ({
                label: formatModelOptionLabel(m, state.config.provider),
                hint: modelInfoHint(m, state.config.provider),
              }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const m = (state.overlay as { options: string[] }).options[i]
                // Remember the pick under the ACTIVE provider, not as a global pin —
                // so it survives a provider switch and never bleeds onto others.
                persistProviderModelFn(state.config.provider, m)
                void agent.switchModel(m)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "mode" && (
            <SelectList
              title="Permission mode"
              items={state.overlay.options.map((m) => ({ label: m }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const m = (state.overlay as { options: (typeof PERMISSION_MODES)[number][] })
                  .options[i]
                persist("permissionMode", m)
                void agent.switchMode(m)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "effortSlider" && (
            <EffortSlider
              off={state.overlay.off}
              index={state.overlay.index}
              width={columns}
              supported={modelSupportsEffort(state.config.provider, activeModel)}
              modelLabel={activeModel}
              onConfirm={({ off, index }) => {
                // Resolve the picked level: off → "off", else the slider tier.
                const lvl: ThinkingLevel = off ? "off" : EFFORT_SLIDER_LEVELS[index]
                // `ultracode` couples to the dynamic-workflow plugin tools; every
                // other tier turns the gate back off (per the slider's contract).
                const pluginTools = lvl === "ultracode"
                persist("thinkingLevel", lvl)
                persistPluginTools(home, pluginTools)
                // switchThinking dispatches SET_THINKING (with pluginTools) AND
                // drops the session so the new effort + gate apply next turn.
                void agent.switchThinking(lvl, pluginTools)
                // Warn (but still save) when the active model won't honour effort —
                // the preference re-applies once a reasoning-capable model is active.
                if (lvl !== "off" && !modelSupportsEffort(state.config.provider, activeModel)) {
                  dispatch({
                    type: "NOTICE",
                    message: `Saved. Note: ${activeModel ?? "the current model"} doesn't support thinking levels — it applies when you switch to a reasoning model (Opus 4.5+, Sonnet 4.6, o-series, …).`,
                  })
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "provider" && (
            <SelectList
              title="Switch provider"
              items={state.overlay.options.map((p) => ({
                label: p.name,
                hint: `${p.id} · ${p.configured ? p.auth : "not configured"}`,
              }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const picked = (state.overlay as { options: { id: string; configured: boolean }[] })
                  .options[i]
                // Reset to the new provider's default model so the active model is
                // always valid for the provider: the provider's own configured model
                // wins, else its curated catalog default (shared model catalog).
                const defaultModel =
                  state.config.providers[picked.id]?.model ?? catalogModelIds(picked.id)[0]
                persist("provider", picked.id)
                // Do NOT pin a top-level model on switch — the provider's own
                // remembered model (or its catalog default) drives the display via
                // resolveActiveModel, so switching never strands another provider's id.
                void agent.switchProvider(picked.id, defaultModel)
                if (!picked.configured) {
                  dispatch({
                    type: "NOTICE",
                    message: `No credential for "${picked.id}" — run: cognia-agent auth login --provider ${picked.id} --api-key <key>`,
                  })
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "config" && (
            <SelectList
              title="Settings"
              items={state.overlay.rows.map((r) => ({ label: r.label, hint: r.value }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const row = (state.overlay as { rows: ConfigMenuRow[] }).rows[i]
                switch (row.action) {
                  case "provider":
                    dispatch({
                      type: "OVERLAY_OPEN",
                      overlay: {
                        kind: "provider",
                        options: collectProviderOptions(state.config),
                        index: 0,
                      },
                    })
                    break
                  case "model": {
                    const options = collectModelOptions(state.config)
                    if (options.length === 0) {
                      dispatch({ type: "NOTICE", message: "No models configured." })
                    } else {
                      dispatch({
                        type: "OVERLAY_OPEN",
                        overlay: { kind: "model", options, index: 0 },
                      })
                    }
                    break
                  }
                  case "mode":
                    dispatch({
                      type: "OVERLAY_OPEN",
                      overlay: { kind: "mode", options: [...PERMISSION_MODES], index: 0 },
                    })
                    break
                  case "thinking":
                    dispatch({
                      type: "OVERLAY_OPEN",
                      overlay: {
                        kind: "effortSlider",
                        ...deriveEffortSliderState(state.config.thinkingLevel),
                      },
                    })
                    break
                  case "auth":
                    dispatch({
                      type: "NOTICE",
                      message: `Auth: ${row.value}. Set with: cognia-agent auth login --provider ${state.config.provider} --api-key <key> | --subscription <token>`,
                    })
                    break
                  case "cwd":
                    dispatch({ type: "NOTICE", message: state.config.cwd })
                    break
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "settings" && (
            <SettingsOverlay
              sections={state.overlay.sections}
              section={state.overlay.section}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMoveRow={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSwitchSection={(delta) => {
                if (state.overlay.kind !== "settings") return
                const len = state.overlay.sections.length
                const next = (((state.overlay.section + delta) % len) + len) % len
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "settings",
                    sections: state.overlay.sections,
                    section: next,
                    index: 0,
                  },
                })
              }}
              onAdjust={(row, delta) => {
                if (row.control.type !== "enum") return
                applySettings(
                  row.control.apply,
                  cycleEnum(row.control.options, row.control.current, delta)
                )
              }}
              onToggle={(row) => {
                if (row.control.type !== "boolean") return
                applySettings(row.control.apply, !row.control.current)
              }}
              onActivate={(row) => activateSettings(row)}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "sessions" && (
            <SelectList
              title="Resume session"
              items={state.overlay.items.map((s) => ({ label: s.title, hint: `${s.turns} turns` }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const picked = (state.overlay as { items: { sessionId: string }[] }).items[i]
                dispatch({ type: "OVERLAY_CLOSE" })
                doResume(picked.sessionId)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "select" && (
            <SelectList
              title={state.overlay.title}
              items={state.overlay.items.map((it) => ({ label: it.label, hint: it.hint }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const o = state.overlay as { items: SelectItem[]; onSelectCommand?: string }
                const item = o.items[i]
                dispatch({ type: "OVERLAY_CLOSE" })
                // View-only lists (no command) just close on Enter.
                if (o.onSelectCommand) runCommandLine(`/${o.onSelectCommand} ${item.id}`.trim())
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "inspect" && (
            <InspectOverlay
              items={state.overlay.items}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const o = state.overlay as { items: InspectItem[] }
                const item = o.items[i]
                const cell = item ? state.cells.find((c) => c.id === item.cellId) : undefined
                if (cell?.kind === "tool") {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "document",
                      title: `${cell.toolName} output`,
                      body: formatToolResultBody(cell),
                      format: "markdown",
                    },
                  })
                } else if (cell?.kind === "bash") {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "document",
                      title: "bash output",
                      body: "# bash\n\n```bash\n" + cell.output + "\n```",
                      format: "markdown",
                    },
                  })
                } else {
                  dispatch({ type: "OVERLAY_CLOSE" })
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "marketplace" && (
            <MarketplaceBrowser
              entries={state.overlay.entries}
              width={columns}
              maxRows={overlayRows}
              onSelect={(ref) => {
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine(`/plugin preview ${ref}`.trim())
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "mcp" && (
            <McpPanel
              servers={state.overlay.servers}
              probing={state.overlay.probing}
              width={columns}
              maxRows={overlayRows}
              onTools={(name) => void openMcpToolsPanel(name, mcpPanelDeps())}
              onAuth={(name) => {
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine(`/mcp auth ${name}`)
              }}
              onReconnect={(name) => void mcpReconnect(name, mcpPanelDeps())}
              onToggle={(name) =>
                void mcpToggleServerInPanel(name, mcpPanelDeps()).then(() => agent.invalidate())
              }
              onAdd={() => {
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine("/mcp add")
              }}
              onRemove={(name) =>
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "confirm",
                    title: "Remove MCP server",
                    body: `Remove **${name}** from \`~/.cognia/mcp.json\`?\n\nRe-add it any time with \`/mcp add\`.`,
                    format: "markdown",
                    onConfirmCommand: `mcp remove ${name}`,
                    onCancelCommand: "mcp",
                  },
                })
              }
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "mcpTools" && (
            <McpToolsPanel
              server={state.overlay.server}
              tools={state.overlay.tools}
              width={columns}
              maxRows={overlayRows}
              onToggle={(tool, enabled) => {
                if (state.overlay.kind !== "mcpTools") return
                mcpToggleTool(state.overlay.server, tool, enabled, mcpPanelDeps())
                agent.invalidate()
              }}
              onBack={() => void runMcpPanel(mcpPanelDeps())}
            />
          )}
          {state.overlay.kind === "skills" && (
            <SkillPanel
              rows={state.overlay.rows}
              width={columns}
              maxRows={overlayRows}
              loadMode={state.config.skillLoadMode ?? "name"}
              onToggleLoadMode={() => {
                const next = (state.config.skillLoadMode ?? "name") === "name" ? "full" : "name"
                applySettings({ kind: "configValue", key: "skillLoadMode" }, next)
              }}
              onToggle={(id) => {
                if (state.overlay.kind !== "skills") return
                const row = state.overlay.rows.find((r) => r.id === id)
                try {
                  setSkillEnabled(home, id, !(row?.enabled ?? false))
                } catch {
                  // read-only home: the badge still flips for this session.
                }
                dispatch({ type: "SKILL_ROW_TOGGLE", id })
                agent.invalidate()
              }}
              onSetAll={(ids, enabled) => {
                if (state.overlay.kind !== "skills") return
                try {
                  setManySkillsEnabled(home, ids, enabled)
                } catch {
                  // read-only home: the badges still flip for this session.
                }
                dispatch({ type: "SKILL_ROWS_SET_MANY", ids, enabled })
                agent.invalidate()
              }}
              onShow={(id) => {
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine(`/skill show ${id}`)
              }}
              onCreate={() => {
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine("/skill create")
              }}
              onDelete={(id) =>
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "confirm",
                    title: "Delete skill",
                    body: `Delete skill \`${id}\`?\n\nBuilt-in and on-disk skills are kept (delete their folder instead).`,
                    format: "markdown",
                    onConfirmCommand: `skill delete ${id}`,
                    onCancelCommand: "skill",
                  },
                })
              }
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "agents" && (
            <AgentsPanel
              rows={state.overlay.rows}
              width={columns}
              maxRows={overlayRows}
              onView={(row) => {
                // A row backed by the live-output store opens the live run page —
                // watch its streamed text/thinking/tools (running OR recently
                // settled). Otherwise fall back to the settled-output pager.
                if (row.liveId && getLiveSubagent(row.liveId, state.sessionId)) {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "agentRun",
                      liveId: row.liveId,
                      name: row.name,
                      task: row.task,
                    },
                  })
                } else if (row.output) {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "document",
                      title: row.name,
                      body: row.output,
                      format: "text",
                    },
                  })
                } else {
                  dispatch({ type: "OVERLAY_CLOSE" })
                  dispatch({
                    type: "NOTICE",
                    message:
                      row.status === "running"
                        ? `"${row.name}" is still running — no output yet.`
                        : `No output recorded for "${row.name}".`,
                  })
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "agentRun" && (
            <AgentRunPage
              liveId={state.overlay.liveId}
              name={state.overlay.name}
              task={state.overlay.task}
              width={columns}
              getEntry={(id) => getLiveSubagent(id, state.sessionId)}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "subagentModels" && (
            <SubagentModelsPanel
              rows={state.overlay.rows}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onCycleModel={(row, delta) =>
                applySubagentModelEdit(row.id, cycleSubagentModel(row, delta))
              }
              onCycleProvider={(row, delta) =>
                applySubagentModelEdit(row.id, cycleSubagentProvider(row, delta))
              }
              onReset={(row) => applySubagentModelEdit(row.id, null)}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "askUser" && (
            <AskUserDialog request={state.overlay.request} onResolve={askUser.resolve} />
          )}
          {state.overlay.kind === "form" && (
            <FormOverlay
              form={state.overlay.form}
              onUpdate={(f) => dispatch({ type: "FORM_UPDATE", form: f })}
              onSubmit={submitForm}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "usage" && (
            <UsagePanel
              usage={state.usage}
              model={activeModel}
              totals={state.sessionTotals}
              contextWindow={state.modelMeta?.contextWindow}
              pricing={state.modelMeta?.pricing}
              usageHistory={state.usageHistory}
              costHistory={state.costHistory}
              toolStats={state.toolStats}
              modelTotals={state.modelTotals}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "limits" && (
            <LimitsPanel
              snapshots={state.overlay.snapshots}
              analysis={state.overlay.analysis}
              now={state.overlay.now}
              rateLimits={state.overlay.rateLimits}
              activeProvider={state.overlay.activeProvider}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "help" && (
            <Help onClose={() => dispatch({ type: "OVERLAY_CLOSE" })} />
          )}
          {state.overlay.kind === "historySearch" && (
            <HistorySearch
              query={state.overlay.query}
              match={state.overlay.match}
              onChar={(ch) => {
                const o = state.overlay as { query: string }
                // A fresh refinement restarts from the most-recent end of history.
                applyHistorySearch(o.query + ch, state.input.history.entries.length)
              }}
              onBackspace={() => {
                const o = state.overlay as { query: string }
                applyHistorySearch(o.query.slice(0, -1), state.input.history.entries.length)
              }}
              onNext={() => {
                const o = state.overlay as { query: string; matchIndex: number }
                // Cycle to the next-older match: pass the current hit's index.
                applyHistorySearch(o.query, o.matchIndex)
              }}
              onAccept={() => {
                const o = state.overlay as { match: string | null }
                dispatch({ type: "OVERLAY_CLOSE" })
                if (o.match) dispatch({ type: "INPUT_SET", buffer: bufferFromText(o.match) })
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "status" && (
            <StatusPanel
              report={state.overlay.report}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "doctor" && (
            <DoctorPanel
              report={state.overlay.report}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
              onViewReport={(stem) => {
                const dirs = resolveCrashLogDirs(process.platform, process.env, os.homedir())
                if (!dirs.crashReportsDir) return
                const nodeFs: CrashLogFs = {
                  readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
                  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
                  statSync: (p) => fs.statSync(p),
                }
                const body = readCrashReportText(dirs.crashReportsDir, stem, nodeFs)
                if (body == null) return
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "document",
                    title: `Crash report · ${stem}`,
                    body,
                    format: "text",
                  },
                })
              }}
              onOpenDir={() => {
                const dirs = resolveCrashLogDirs(process.platform, process.env, os.homedir())
                const dir = dirs.crashReportsDir
                if (!dir) return
                const platform = process.platform
                const cmd =
                  platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open"
                const args = platform === "win32" ? [dir] : [dir]
                spawn(cmd, args, { stdio: "ignore", detached: true }).unref()
              }}
            />
          )}
          {state.overlay.kind === "document" && (
            <DocumentViewer
              title={state.overlay.title}
              body={state.overlay.body}
              format={state.overlay.format}
              lang={state.overlay.lang}
              onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "plan" && (
            <PlanApprovalOverlay
              index={state.overlay.index}
              savedTo={state.overlay.savedTo}
              raw={state.overlay.raw}
              prevPlan={state.overlay.prevPlan}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={onPlanDecision}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )}
          {state.overlay.kind === "confirm" && (
            <ConfirmOverlay
              title={state.overlay.title}
              body={state.overlay.body}
              format={state.overlay.format}
              onConfirm={() => {
                const cmd = (state.overlay as { onConfirmCommand: string }).onConfirmCommand
                dispatch({ type: "OVERLAY_CLOSE" })
                runCommandLine(`/${cmd}`.trim())
              }}
              onCancel={() => {
                const cancel = (state.overlay as { onCancelCommand?: string }).onCancelCommand
                dispatch({ type: "OVERLAY_CLOSE" })
                if (cancel) runCommandLine(`/${cancel}`.trim())
              }}
            />
          )}
          <BottomStatus
            turnStatus={state.turnStatus}
            activity={state.activity}
            tools={inflightTools}
            steerQueue={state.steerQueue}
            since={streamStartedAt}
            lastActivityAt={lastActivityAt}
            subagentRunning={footerSubagentRunning}
            backgroundSubagents={footerBackgroundSubagents}
            interruptedBackgroundSubagents={interruptedBackgroundSubagents}
            copilot={footerCopilot}
            verbose={state.verbose}
            backtrackArmed={backtrackArmed}
            columns={columns}
            chipRowRef={subagentChipRef}
          />
          {cursor.state.find && (
            <FindBar
              query={cursor.state.find.query}
              matchCount={cursor.matchCount}
              matchIndex={cursor.matchIndex}
            />
          )}
          {/* Backtrack-to-edit status: while selecting, the composer is inert and
              ↑/↓ choose a message (shown as #position/total so it reads even in
              scrollback mode, where the transcript can't highlight the cell); once
              a target is committed, warn how many later turns the edit discards. */}
          {state.backtrack &&
            (() => {
              const { pos, total } = userMessageStats(state.cells, state.backtrack.index)
              return (
                <Box flexShrink={0}>
                  <Text color={themePalette.warning}>
                    {`✎ Editing message #${pos}/${total} — ↑/↓ choose · Enter to edit · Esc to cancel`}
                  </Text>
                </Box>
              )
            })()}
          {state.editTarget &&
            (() => {
              const { pos, total, later } = userMessageStats(state.cells, state.editTarget.index)
              return (
                <Box flexShrink={0}>
                  <Text color={themePalette.warning}>
                    {`✎ Editing message #${pos}/${total} · ${later} later turn(s) will be discarded on send · Esc to cancel`}
                  </Text>
                </Box>
              )
            })()}
          {!overlayOpen && !cursor.state.find && (
            <Input
              input={state.input}
              dispatch={dispatch}
              onSubmit={handleSubmit}
              onHistoryPush={handleHistoryPush}
              // Inert while a backtrack-to-edit selection is active (App owns ↑/↓/
              // Enter then); otherwise stays active even during a turn so a `btw`
              // steer can be typed mid-stream (`handleSubmit` queues it).
              disabled={!!state.backtrack}
              cwd={state.config.cwd}
              listDir={listDir}
              mentionProviders={mentionProviders}
              width={columns}
              popupRows={popupRows}
              keybindings={keybindings}
              mode={state.config.permissionMode}
              enabledSkillIds={enabledSkillIds}
              onToggleSkill={toggleSkillEnabled}
              onPopupOpenChange={handlePopupOpenChange}
            />
          )}
          <Mascot
            mood={selectMascotMood({
              turnStatus: state.turnStatus,
              hasThinking: state.inflight.thinking.length > 0,
              activityRunning: state.activity?.status === "running",
            })}
            style={state.config.mascot?.style ?? "clawd"}
            enabled={state.config.mascot?.enabled !== false}
          />
          <Footer
            config={state.config}
            usage={state.usage}
            totals={state.sessionTotals}
            contextWindow={state.modelMeta?.contextWindow}
            rateLimits={state.rateLimits}
            turnStatus={state.turnStatus}
            planTitle={footerPlanTitle}
            columns={columns}
          />
        </Box>
      </RenderPrefsProvider>
    </ThemeProvider>
  )
}
