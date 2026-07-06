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
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Box, useApp, useStdout, type DOMElement } from "ink"

import { Banner } from "./Banner"
import { useScroll } from "../hooks/useScroll"
import { useTranscriptCursor } from "../hooks/useTranscriptCursor"
import { resolveLayoutMode, readLayoutCapability, type LayoutCapability } from "../layout-mode"
import { type ScreenStream } from "../screen"
import { type TitleStream, type TitleEnv } from "../terminal-title"
import { ThemeProvider } from "../theme/context"
import { RenderPrefsProvider } from "../render/context"
import { resolveTheme } from "../theme/resolve"
import { StartupGate } from "./StartupGate"
import type { ListDirs } from "./FolderPicker"
import { trustFolder as defaultTrustFolder } from "../../config/trusted-folders"
import { listSessions, type ReadDir } from "./sessions-list"
import { recomputeSubagentModelRows } from "../runtime/subagent-models-model"
import { useAskUserOverlay } from "../hooks/use-ask-user-overlay"
import { savePlan } from "../runtime/plan-store"
import {
  planFileName,
  planTitle,
  planDecisionMode,
  PLAN_APPROVED_PROMPT,
  PLAN_EXECUTE_PROMPT,
  type PlanDecision,
} from "../runtime/plan"
import { collectModelOptions } from "./model-options"
import { dispatchCommand } from "../commands/dispatch"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { preprocessMentions } from "../mention/preprocess"
import { skillSetEnabled } from "../runtime/skill-controller"
import { mcpAuthStartupNotices } from "../runtime/mcp-controller"
import { createMcpProbeCache } from "../runtime/mcp-cache"
import {
  readEnabled as readEnabledSkills,
  setEnabled as setSkillEnabled,
} from "../../skill/skill-state"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { buildAgents, discoverAgentFiles } from "../../agent/discover-agents"
import { parseBang } from "../commands/bash-shellout"
import { parseHashMemory } from "../input/hash-memory"
import {
  runShell as defaultRunShell,
  type ShellResult,
  type RunShellOpts,
} from "../../agent/run-shell"
import { registerFeatureCommands } from "../commands"
import { runGoalStreaming } from "../runtime/goal-run"
import { runLoopStreaming } from "../runtime/loop-run"
import { runFixStreaming } from "../runtime/fix-run"
import { frameSteer } from "../runtime/driven-turns"
import { copilotCheckProposal } from "../runtime/workflow-copilot-controller"
import { resolveModelMeta, type ModelMeta } from "../runtime/model-meta"
import { initOpenRouterCatalog as defaultInitOpenRouterCatalog } from "../runtime/openrouter-catalog-controller"
import { registerCustomCommands as defaultRegisterCustomCommands } from "../commands/custom-commands"
import { resolveActiveModel } from "../../config/active-model"
import { shouldAutoCompact } from "../../agent/auto-compact"
import { ensureCliDb } from "../../db/bootstrap"
import { formSubmit } from "../state/form"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { isBusy } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { runningSubagents } from "../format/subagent"
import type { StatusSegmentView } from "../format/status-bar"
import {
  countInterruptedCliBackgroundRuns,
  countRunningCliBackgroundRuns,
} from "../../agent/subagent-background-tasks"
import { copyToClipboard, type CopyResult } from "../clipboard"
import { readClipboardImage as defaultReadClipboardImage } from "../clipboard-image"
import { searchHistory } from "../input/history-search"
import { bufferText, insertText } from "../input/buffer"
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
  setBuiltinTools,
  setBooleanFlag,
  setBuiltinHookOverride,
  setRenderConfig,
  setNumberConfig,
  setClipboardConfig,
  setSubagentModel,
  setEditorConfig,
} from "../../config/mutate"
import { openInEditor, detectEditor } from "../runtime/editor"
import { resolveKeybindings } from "../input/keybindings"
import {
  DEFAULT_MOUSE_MODE,
  resolveRenderConfig,
  resolveNotices,
  type SubagentModelOverride,
} from "../../config/schema"
import { VERSION } from "../../version"
import {
  settingsSections,
  NUMERIC_RENDER_KEYS,
  type SettingsRow,
  type SettingsApplyTarget,
} from "../runtime/settings-sections"
import type { BuiltinToolsConfig } from "@/lib/claude/types"
import type { ListDir } from "../commands/file-completer"
import type {
  ResolvedConfig,
  StatusBarConfig,
  MascotConfig,
  ClipboardConfig,
  EditorConfig,
  OutputStyle,
  StatusTheme,
  MascotStyle,
} from "../../config/schema"
import { clearTerminal, readThemeFile } from "./app/app-helpers"
import { useBashShellout } from "./app/use-bash-shellout"
import { useBacktrack } from "./app/use-backtrack"
import { useSteerQueue } from "./app/use-steer-queue"
import { useTerminalChrome } from "./app/use-terminal-chrome"
import { TranscriptRegion } from "./app/TranscriptRegion"
import { AppOverlays } from "./app/AppOverlays"
import { BottomRegion } from "./app/BottomRegion"
import type { AgentTreeHit } from "./BottomStatus"
import { useGlobalKeys } from "./app/use-global-keys"
import { useApplyEffect } from "./app/use-apply-effect"

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
  /** Persist a `/editor <command>` change to config.json; defaults to the real writer. */
  persistEditor?: (home: string, patch: EditorConfig) => void
  /** Spawn the editor for `/open`; defaults to the real `openInEditor` (injected
   * in tests so they never launch a real editor). */
  openInEditorFn?: typeof openInEditor
  /** Read a persisted plan file back (for fresh-session execution after an
   * "Edit plan first"); defaults to a best-effort fs read. Injected in tests. */
  loadPlanFile?: (file: string) => string | null
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
  /** Prime + (if stale) refresh the OpenRouter live-models catalog at boot, so
   * the `/model` picker reflects the synced real-time list. Defaults to the real
   * controller; injected as a no-op by tests so they don't open the db / network. */
  initOpenRouterCatalog?: (opts?: { apiKey?: string }) => Promise<void>
  /** Discover + register `.claude/commands` / `.cognia/commands` prompt templates
   * as slash commands. Defaults to the real disk scanner; injected as a no-op by
   * tests so they never touch disk. */
  registerCustomCommands?: (opts: { cwd: string; osHome: string }) => Promise<unknown>
  /** Persist a captured plan to `~/.cognia/plans`; defaults to the real writer.
   * Returns the path written (or null on failure). Injected as a no-op by tests. */
  persistPlan?: (home: string, fileName: string, raw: string) => string | null
  /** Start a streaming `/goal` run; defaults to {@link runGoalStreaming}. Injected
   * by tests so they don't touch the CLI-local db / judge. */
  startGoalRun?: typeof runGoalStreaming
  /** Start a streaming `/loop` run; defaults to {@link runLoopStreaming}. Injected
   * by tests so they don't touch the CLI-local db / loop engine. */
  startLoopRun?: typeof runLoopStreaming
  /** Start a streaming `/fix` test-fix loop; defaults to {@link runFixStreaming}.
   * Injected by tests so they don't spawn a real test process. */
  startFixRun?: typeof runFixStreaming
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
  persistEditor = setEditorConfig,
  openInEditorFn = openInEditor,
  loadPlanFile = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return null
    }
  },
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
  initOpenRouterCatalog = defaultInitOpenRouterCatalog,
  registerCustomCommands = defaultRegisterCustomCommands,
  persistPlan = savePlan,
  startGoalRun = runGoalStreaming,
  startLoopRun = runLoopStreaming,
  startFixRun = runFixStreaming,
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
  // The running-agents tree in the BottomStatus: BottomStatus publishes the
  // rendered box + agent rows here so a click on a row opens that agent's live
  // run page directly (Claude Code parity).
  const agentTreeRef = useRef<AgentTreeHit | null>(null)
  // The persistent status footer row + its rendered segments, so a click on the
  // model/mode/thinking segment opens the matching picker (Claude Code parity).
  const footerRowRef = useRef<DOMElement | null>(null)
  const footerSegmentsRef = useRef<StatusSegmentView[] | null>(null)
  // The fullscreen scroll viewport's content box (its `marginTop={-offset}`
  // encodes the scroll position), so a transcript click can be mapped to the
  // cell under it when the click-to-expand pref is on.
  const scrollContentRef = useRef<DOMElement | null>(null)
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
  // Exposed to `useApplyEffect` through stable accessors (not the raw ref) so the
  // hook never mutates a prop.
  const runtimeAbort = useRef<AbortController | null>(null)
  const setRuntimeAbort = useCallback((c: AbortController | null) => {
    runtimeAbort.current = c
  }, [])
  const getRuntimeAbort = useCallback(() => runtimeAbort.current, [])

  // The `!command` shell-out cluster (live cells + foreground/background lifecycle
  // + last-failure capture for `/analyze`). `runBash` is consumed by `applyEffect`
  // and `handleSubmit`; the kill/background entry points by the key handler.
  const {
    runBash,
    backgroundForegroundBash,
    killForegroundBash,
    hasForegroundRun,
    takeLastFailedBash,
  } = useBashShellout(runShell, state.config.cwd, dispatch)

  // Double-Esc backtrack-to-edit selection (armed/disarmed state + timer).
  const { backtrackArmed, backtrackArmedRef, armBacktrack, disarmBacktrack } = useBacktrack()

  // `btw` steer mirror — the ref the async goal/loop driver + plain-turn drain
  // read, plus `takeSteer` to drain the queue into one framed prompt.
  const { takeSteer } = useSteerQueue(state.steerQueue, dispatch)

  // Reactive terminal size. `columns` drives the full-width composer/overlays
  // (so the UI fills the terminal like Claude Code) and `rows` budgets how many
  // list rows fit before scrolling. The live frame reflows the instant this
  // updates; only the heavy `<Static>` repaint below is debounced.
  const { columns, rows } = useTerminalSize()
  // Row budget for inline popups, which sit above the composer so they stay
  // compact. (`overlayRows`, which depends on the resolved `fullscreen` flag, is
  // computed once that's known — see below.)
  const popupRows = Math.max(3, Math.min(10, rows - 6))

  // One shared MCP probe cache for the whole App session: the startup warm seeds
  // it, and every `/mcp` panel / tool-list / reconnect reuses it, so re-opening
  // `/mcp` renders instantly instead of re-connecting to every server.
  const mcpProbeCache = useMemo(() => createMcpProbeCache(), [])

  // Minimal MCP deps for the interactive panel's in-place actions (toggle /
  // reconnect / tools / remove). Built per render so it tracks the live config;
  // carries the shared probe cache so the panel reads cached status.
  const mcpPanelDeps = () => ({
    dispatch,
    roots: [state.config.cwd, home],
    home,
    probeCache: mcpProbeCache,
  })

  // One-time boot warm: probe every enabled MCP server once and seed the shared
  // cache (so `/mcp` opens instantly), and warn (via a NOTICE cell) about any
  // enabled remote server that needs authorization. Fires once per session as
  // soon as we enter the chat phase; the probe is async and never blocks the
  // first frame.
  const mcpAuthChecked = useRef(false)
  useEffect(() => {
    if (state.phase !== "chat" || mcpAuthChecked.current) return
    mcpAuthChecked.current = true
    void mcpAuthStartupNotices({
      dispatch,
      roots: [state.config.cwd, home],
      home,
      probeCache: mcpProbeCache,
    })
  }, [state.phase, state.config.cwd, home, dispatch, mcpProbeCache])

  // Effective layout: the configured preference (default `fullscreen`) gated by
  // terminal capability — a non-TTY / dumb terminal always falls back to the
  // scrollback `<Static>` tree (which is also why every existing test, rendered
  // under jsdom with no TTY, keeps the historic layout untouched).
  const capability = layoutCapability ?? readLayoutCapability()
  const fullscreen = resolveLayoutMode(state.config.layout, capability) === "fullscreen"
  // Row budget for the modal overlay list (e.g. `/model`). The list's own chrome
  // (border/title/footer/scroll hints) plus the bottom status/mascot/footer cost
  // ~8 rows. In fullscreen the FIXED top banner (~7 rows) is also on-screen above
  // the overlay, so reserve for it too — otherwise a long list builds a box taller
  // than the terminal and the highlighted row scrolls off the bottom (the cursor
  // "disappears"). In scrollback mode the banner scrolls away, so ~8 is enough.
  const overlayRows = Math.max(3, rows - (fullscreen ? 15 : 8))
  // Fullscreen mouse model (default = native click-drag selection). Drives the
  // alt-screen mouse escapes below and whether the wheel scrolls the transcript.
  const mouseMode = state.config.mouse ?? DEFAULT_MOUSE_MODE

  const { stdout } = useStdout()
  // Sink for the alt-screen enter/exit + mouse escapes (also re-applied live by
  // `applyEffect`'s `mouse` case, so it stays in App scope).
  const screen: ScreenStream = screenOut ?? (stdout as unknown as ScreenStream)
  // Title/bell inputs, derived once and fed to the terminal-chrome hook below.
  const titleEnabled = state.config.terminalTitle !== false
  const titleSink: TitleStream = titleOut ?? (stdout as unknown as TitleStream)
  const awaitingInput = state.overlay.kind === "permission" || state.overlay.kind === "askUser"
  const activityKind =
    state.activity && state.activity.status === "running" ? state.activity.kind : undefined
  const notifyEnabled = state.config.notify === true
  // Desktop notifications ride on top of the bell: enabled only when notify is on
  // AND the user hasn't explicitly opted out (`desktopNotifications: false`).
  const desktopNotifyEnabled = notifyEnabled && state.config.desktopNotifications !== false

  // Terminal-integration effects: alt-screen + mouse lifecycle, dynamic
  // window/tab title, opt-in completion bell, and the scrollback resize repaint.
  useTerminalChrome({
    fullscreen,
    screen,
    mouseMode,
    altScreenPreEntered,
    stdout,
    clearScreen,
    dispatch,
    titleEnabled,
    titleSink,
    titleEnv,
    busy,
    awaitingInput,
    activityKind,
    cwd: state.config.cwd,
    notifyEnabled,
    desktopNotifyEnabled,
    lastCompletion: state.lastCompletion,
    now,
  })

  // Scroll controller for the fullscreen viewport (no-op in scrollback mode,
  // where the terminal's native scrollback handles it).
  const scroll = useScroll()
  // Stable reference for the submit/clear re-pin (the rest of `scroll` is read
  // during render, but this one is closed over by callbacks).
  const scrollReset = scroll.reset
  // Find-in-viewport cursor (fullscreen only). Drives the FindBar, the focused
  // cell's highlight, per-cell copy, and the jump-to-match scroll below.
  const cursor = useTranscriptCursor(state.cells, fullscreen && renderPrefs.clickToExpand)
  // Jump the viewport so the focused match lands ~1/3 down, re-running as the
  // gated per-cell measurements settle (cursor.targetRow folds in their version).
  const cursorTargetRow = cursor.targetRow
  useEffect(() => {
    if (cursorTargetRow !== null) scroll.toRow(cursorTargetRow)
    // `scroll.toRow` is rebuilt every render; depend only on the target so a jump
    // fires when the focus/measurement changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorTargetRow])

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

  // Prime + background-refresh the OpenRouter live-models catalog whenever
  // OpenRouter is the active provider, so the `/model` picker reflects the synced
  // real-time list (the same shared row the desktop GUI uses). Gated on the
  // provider so a user who never touches OpenRouter pays no db/network cost.
  // Best-effort — the controller swallows its own failures.
  const openRouterApiKey = state.config.providers.openrouter?.apiKey
  useEffect(() => {
    if (activeProvider !== "openrouter") return
    void initOpenRouterCatalog({ apiKey: openRouterApiKey })
  }, [activeProvider, initOpenRouterCatalog, openRouterApiKey])

  // Discover user-authored `.claude/commands` / `.cognia/commands` prompt
  // templates and register them as slash commands. Registration is guarded +
  // idempotent, so the effect is safe to re-run; `matchSlash` reads the registry
  // live, so the new commands surface the moment the async scan resolves — same
  // contract as the OpenRouter catalog init above. Best-effort (swallows errors).
  useEffect(() => {
    void registerCustomCommands({ cwd: state.config.cwd, osHome })
  }, [registerCustomCommands, state.config.cwd, osHome])

  // For a dynamic-catalog provider (OpenRouter) the synced live list may not be
  // primed when the `/model` picker opens. Kick off a sync and swap the full
  // real-time catalog into the still-open picker the moment it lands — without
  // this the picker shows the static fallback subset and looks like it "never
  // updates". No-op for every other provider (their lists are static/synchronous).
  const syncAndRefreshModelOverlay = useCallback(() => {
    if (state.config.provider !== "openrouter") return
    void initOpenRouterCatalog({ apiKey: openRouterApiKey }).then(() => {
      dispatch({
        type: "OVERLAY_REFRESH_MODEL_OPTIONS",
        options: collectModelOptions(state.config),
      })
    })
  }, [state.config, dispatch, initOpenRouterCatalog, openRouterApiKey])

  // Open the `/model` switcher instantly with whatever models are cached, then
  // live-refresh once the dynamic catalog sync resolves.
  const openModelPicker = useCallback(() => {
    const options = collectModelOptions(state.config)
    if (options.length === 0) {
      dispatch({ type: "NOTICE", message: "No models configured." })
      return
    }
    dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "model", options, index: 0, query: "" } })
    syncAndRefreshModelOverlay()
  }, [state.config, dispatch, syncAndRefreshModelOverlay])

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

  // Folder picker confirmed a directory (or `/cd <dir>`): switch cwd, trust it,
  // and enter chat. `agent.changeCwd` dispatches SET_CWD and recreates the
  // session so the new cwd reaches the next turn (and respawns the sidecar under
  // it). A live mid-session `/cd` therefore actually relocates the agent, not
  // just the `/cwd` display.
  const changeCwd = useCallback(
    (dir: string) => {
      try {
        trustFolderFn(home, dir)
      } catch {
        // best-effort persistence
      }
      void agent.changeCwd(dir)
      dispatch({ type: "STARTUP_TRUST" })
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

  // Resolve a plan-approval choice (Claude Code parity — the execution mode is
  // chosen at approval time):
  //   - approve-auto / approve-confirm: switch to a build mode (acceptEdits /
  //     default) and implement IN CONTEXT (the plan above is still visible).
  //   - approve-new-session: mint a FRESH session (clean context), switch to
  //     acceptEdits, and inject the plan text (reloaded from disk so any
  //     "Edit plan first" revisions are honoured). The leading plan title
  //     auto-names the run in the sessions list.
  //   - edit-then-approve: open the saved plan in $EDITOR and KEEP the overlay
  //     open so the user can revise, then approve.
  //   - keep: close and stay in plan mode.
  const onPlanDecision = useCallback(
    (decision: PlanDecision) => {
      const planOverlay = state.overlay.kind === "plan" ? state.overlay : null

      // Edit-first: launch the editor on the saved plan, leave the overlay up.
      if (decision === "edit-then-approve") {
        const file = planOverlay?.savedTo
        if (!file) {
          dispatch({ type: "NOTICE", message: "No saved plan file to edit yet." })
          return
        }
        const { editor } = detectEditor(process.env, { config: state.config.editor })
        void openInEditorFn(file, { editor }).then((ok) =>
          dispatch({
            type: "NOTICE",
            message: ok
              ? `Editing ${file} in ${editor.displayName} — save it, then pick an approve option to run the edited plan.`
              : `Couldn't launch an editor — edit ${file} manually, then approve.`,
          })
        )
        return
      }

      dispatch({ type: "OVERLAY_CLOSE" })
      if (decision === "keep") return

      // Fresh-session execution: clean context, auto-edits, embed the (reloaded)
      // plan so the new session has the full brief.
      if (decision === "approve-new-session") {
        const reloaded = planOverlay?.savedTo ? loadPlanFile(planOverlay.savedTo) : null
        const raw = reloaded ?? planOverlay?.raw ?? ""
        persist("permissionMode", "acceptEdits")
        void (async () => {
          await agent.clear(mintId())
          await agent.switchMode("acceptEdits")
          await agent.send(raw ? PLAN_EXECUTE_PROMPT(raw) : PLAN_APPROVED_PROMPT)
        })()
        return
      }

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
    [agent, persist, state.overlay, state.config.editor, openInEditorFn, loadPlanFile, mintId]
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

  // Interpret a pure CommandEffect produced by the dispatcher — see useApplyEffect.
  const applyEffect = useApplyEffect({
    agent,
    dispatch,
    state,
    home,
    osHome,
    mintId,
    clearScreen,
    scrollReset,
    cursor,
    copyClipboard,
    notices,
    pushHandoff,
    openSessions,
    resumeMostRecent,
    runBash,
    takeLastFailedBash,
    persistStatusBar,
    persistMascot,
    persistEditor,
    openInEditorFn,
    runShell,
    persist,
    persistDb,
    fullscreen,
    screen,
    startGoalRun,
    startLoopRun,
    startFixRun,
    syncAndRefreshModelOverlay,
    takeSteer,
    doExit,
    changeCwd,
    setRuntimeAbort,
    getRuntimeAbort,
    mcpProbeCache,
  })

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
      // `# fact` quick-captures a memory (Claude Code parity) instead of sending
      // to the model — reuses /remember (→ memory add). Checked before bang/slash.
      const memo = parseHashMemory(text)
      if (memo !== null) {
        runCommandLine(`/remember ${memo}`)
        return
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
          case "numberValue": {
            // Arrives as a string from an enum row; the schema stores a number.
            const num = Number(value)
            patch = { [target.key]: num } as Partial<ResolvedConfig>
            setNumberConfig(home, target.key, num)
            invalidate = true
            break
          }
          case "clipboard": {
            // osc52 is a string mode; osc52MaxBytes a number. Read live at copy
            // time from state.config, so no SendOptions invalidation needed.
            const clipPatch = (
              target.key === "osc52" ? { osc52: String(value) } : { osc52MaxBytes: Number(value) }
            ) as ClipboardConfig
            patch = { clipboard: { ...cfg.clipboard, ...clipPatch } }
            setClipboardConfig(home, clipPatch)
            break
          }
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

  // Global key handler: Ctrl+C ladder, find-in-viewport, backtrack-to-edit,
  // fullscreen scroll/mouse routing, chord actions, Shift+Tab, double-Esc.
  useGlobalKeys({
    state,
    dispatch,
    overlayOpen,
    busy,
    fullscreen,
    mouseMode,
    notices,
    keybindings,
    renderPrefs,
    now,
    doExit,
    agent,
    abortRuntime,
    askUser,
    hasForegroundRun,
    killForegroundBash,
    backgroundForegroundBash,
    copyClipboard,
    runCommandLine,
    openModelPicker,
    persist,
    pasteClipboardImage,
    scrollReset,
    disarmBacktrack,
    armBacktrack,
    cursor,
    scroll,
    clearScreen,
    composerPopupOpen,
    subagentChipRef,
    agentTreeRef,
    footerRowRef,
    footerSegmentsRef,
    scrollContentRef,
    backtrackArmedRef,
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
          <TranscriptRegion
            state={state}
            fullscreen={fullscreen}
            banner={banner}
            activeModel={activeModel}
            scroll={scroll}
            scrollContentRef={scrollContentRef}
            cursor={cursor}
            mutedColor={themePalette.muted}
          />
          <AppOverlays
            state={state}
            dispatch={dispatch}
            agent={agent}
            columns={columns}
            overlayRows={overlayRows}
            activeModel={activeModel}
            home={home}
            resolvePermission={resolvePermission}
            persist={persist}
            persistProviderModelFn={persistProviderModelFn}
            persistPluginTools={persistPluginTools}
            openModelPicker={openModelPicker}
            applySettings={applySettings}
            activateSettings={activateSettings}
            applySubagentModelEdit={applySubagentModelEdit}
            applyHistorySearch={applyHistorySearch}
            doResume={doResume}
            runCommandLine={runCommandLine}
            submitForm={submitForm}
            onPlanDecision={onPlanDecision}
            askUser={askUser}
            mcpPanelDeps={mcpPanelDeps}
          />
          <BottomRegion
            state={state}
            dispatch={dispatch}
            cursor={cursor}
            overlayOpen={overlayOpen}
            columns={columns}
            popupRows={popupRows}
            warningColor={themePalette.warning}
            streamStartedAt={streamStartedAt}
            lastActivityAt={lastActivityAt}
            footerSubagentRunning={footerSubagentRunning}
            footerBackgroundSubagents={footerBackgroundSubagents}
            interruptedBackgroundSubagents={interruptedBackgroundSubagents}
            footerCopilot={footerCopilot}
            backtrackArmed={backtrackArmed}
            subagentChipRef={subagentChipRef}
            agentTreeRef={agentTreeRef}
            handleSubmit={handleSubmit}
            handleHistoryPush={handleHistoryPush}
            listDir={listDir}
            mentionProviders={mentionProviders}
            keybindings={keybindings}
            enabledSkillIds={enabledSkillIds}
            toggleSkillEnabled={toggleSkillEnabled}
            handlePopupOpenChange={handlePopupOpenChange}
            footerPlanTitle={footerPlanTitle}
            footerRowRef={footerRowRef}
            footerSegmentsRef={footerSegmentsRef}
          />
        </Box>
      </RenderPrefsProvider>
    </ThemeProvider>
  )
}
