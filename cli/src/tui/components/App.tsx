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
import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { Box, useApp, useInput, useStdout } from "ink"

import { Banner } from "./Banner"
import { ThemeProvider } from "../theme/context"
import { resolveTheme } from "../theme/resolve"
import { Footer } from "./Footer"
import { Inflight } from "./Inflight"
import { WorkflowRunPanel } from "./WorkflowRunPanel"
import { Mascot } from "./Mascot"
import { selectMascotMood } from "../mascot/mascot"
import { Input } from "./Input"
import { SelectList } from "./SelectList"
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
import { ConfirmOverlay } from "./overlays/ConfirmOverlay"
import { PlanApprovalOverlay } from "./overlays/PlanApprovalOverlay"
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

import { collectModelOptions, formatModelOptionLabel } from "./model-options"
import { collectProviderOptions } from "../commands/provider-options"
import { FormOverlay } from "./overlays/FormOverlay"
import { dispatchCommand } from "../commands/dispatch"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { preprocessMentions } from "../mention/preprocess"
import { skillSetEnabled } from "../runtime/skill-controller"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { buildAgents, discoverAgentFiles } from "../../agent/discover-agents"
import { cyclePermissionMode } from "../input/mode-cycle"
import { parseBang, formatBashResult } from "../commands/bash-shellout"
import { runShell as defaultRunShell, type ShellResult } from "../../agent/run-shell"
import { registerFeatureCommands } from "../commands"
import { runRuntimeRequest } from "../runtime"
import { runGoalStreaming } from "../runtime/goal-run"
import { runLoopStreaming } from "../runtime/loop-run"
import { frameSteer } from "../runtime/driven-turns"
import { resolveModelMeta, type ModelMeta } from "../runtime/model-meta"
import { resolveActiveModel } from "../../config/active-model"
import { ensureCliDb } from "../../db/bootstrap"
import { createForm, formSubmit } from "../state/form"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { isBusy } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { runningSubagents } from "../format/subagent"
import { copyToClipboard } from "../clipboard"
import { readClipboardImage as defaultReadClipboardImage } from "../clipboard-image"
import { searchHistory } from "../input/history-search"
import { bufferFromText, bufferText, insertText } from "../input/buffer"
import { appendHistory } from "../input/history-store"
import { useAgentSession, type CreateSession } from "../hooks/useAgentSession"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { addToolApproval } from "../../agent/tool-approvals"
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
} from "../../config/mutate"
import { computeAddDir } from "../runtime/add-dir"
import { EFFORT_SLIDER_LEVELS, PERMISSION_MODES, type ThinkingLevel } from "../../config/schema"
import { deriveEffortSliderState, modelSupportsEffort } from "../../config/thinking"
import { VERSION } from "../../version"
import type { ListDir } from "../commands/file-completer"
import type { CommandEffect } from "../commands/types"
import type { ConfigMenuRow } from "../commands/config-menu"
import type { SelectItem } from "../state/types"
import type { ResolvedConfig, StatusBarConfig, MascotConfig } from "../../config/schema"

const DOUBLE_CTRL_C_MS = 1000

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

/** Read a theme config file, or null when it doesn't exist / can't be read. */
function readThemeFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
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
  copyClipboard?: (text: string) => Promise<boolean>
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
  runShell?: (command: string, opts: { cwd?: string }) => Promise<ShellResult>
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
  copyClipboard = copyToClipboard,
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
}: AppProps) {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(tuiReducer, undefined, () =>
    createInitialState(config, sessionId, trusted, initialHistory)
  )
  const agent = useAgentSession({
    config: state.config,
    dispatch,
    createSession,
    getCellCount: () => state.cells.length,
  })
  const busy = isBusy(state)
  const overlayOpen = state.overlay.kind !== "none"

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
  // Abort controller for the active background runtime run (goal/workflow/…).
  const runtimeAbort = useRef<AbortController | null>(null)
  // Timer that clears the Ctrl+C double-press window after the hint expires, so a
  // single press doesn't linger waiting for a second press forever.
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Terminal resize recovery. `<Static>` wrote the transcript into the
  // scrollback at the OLD width; on resize Ink reflows its live frame over that
  // stale content, smearing the layout (duplicated lines, stray full-width
  // rules). Clear the screen and bump the render epoch so `<Static>` remounts
  // and re-prints every cell at the new width — debounced so a drag doesn't
  // thrash the whole scrollback on every intermediate size.
  const { stdout } = useStdout()
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!stdout?.on) return
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
  }, [stdout, clearScreen])

  // Resolve the active model's context window + pricing from the models.dev
  // catalog whenever the provider or model changes, so the context gauge sizes
  // to the real window (not the 200k fallback) and the cost segment can price
  // turns the SDK reports as $0 (every non-Anthropic provider). Best-effort and
  // async — a missing catalog leaves the pattern-table window in place.
  const activeModel = resolveActiveModel(state.config)
  const activeProvider = state.config.provider
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
          void agent.compact(effect.focus)
          break
        case "clear":
          // Wipe the terminal first (Static scrollback won't clear itself), then
          // reset state so Ink repaints the empty transcript onto a blank screen.
          clearScreen()
          void agent.clear(mintId())
          break
        case "copy":
          void Promise.resolve(copyClipboard(effect.text)).then((ok) =>
            dispatch({
              type: "NOTICE",
              message: ok ? "Copied the last reply to the clipboard." : "Clipboard is unavailable.",
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
          }
          dispatch({ type: "NOTICE", message: r.message })
          break
        }
        case "runBash":
          // Wired in the input/output-enhancements wave.
          dispatch({ type: "NOTICE", message: "Shell-out is not available yet." })
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
            ...(state.initDraft ? { initDraft: state.initDraft } : {}),
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
      startGoalRun,
      startLoopRun,
      takeSteer,
      state.config,
      state.sessionId,
      state.usage,
      state.modelMeta,
      state.usageHistory,
      state.toolStats,
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

  const runBash = useCallback(
    (command: string) => {
      dispatch({ type: "BASH_START", command })
      void Promise.resolve(runShell(command, { cwd: state.config.cwd }))
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
        knownSkillIds: async () => new Set((await mentionProviders.skills("")).map((c) => c.id)),
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

  const handleSubmit = useCallback(
    (text: string) => {
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
        void sendThenDrainSteer(text)
        return
      }
      runCommandLine(text)
    },
    [busy, runBash, runCommandLine, sendThenDrainSteer]
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
        try {
          persistToolApproval(home, state.overlay.req.toolName)
        } catch {
          // best-effort — a read-only home shouldn't break the turn.
        }
        agent.invalidate()
      }
      agent.resolvePermission(decision)
    },
    [agent, home, persistToolApproval, state.overlay]
  )

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
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
    // Ctrl+T toggles tool/thinking output for the whole transcript (moved off
    // Ctrl+R, which now opens history search). The composer ignores unhandled
    // ctrl chords, and overlays own input while open, so this only fires in the
    // normal chat view. The transcript lives in `<Static>` (write-once), so clear
    // the screen and let the bumped epoch re-print every cell with the new
    // collapsed state.
    if (key.ctrl && input === "t" && !overlayOpen) {
      clearScreen()
      dispatch({ type: "TOGGLE_COLLAPSE_ALL" })
      return
    }
    // Ctrl+R opens reverse-history-search over the composer history (readline
    // parity). The overlay owns input once open; here we just open it seeded with
    // an empty query and no match yet.
    if (key.ctrl && input === "r" && !overlayOpen) {
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
    // Ctrl+O toggles persistent detailed-output mode (Claude Code parity): all
    // tool/thinking cells render expanded until toggled off. Same write-once
    // repaint dance as Ctrl+R.
    if (key.ctrl && input === "o" && !overlayOpen) {
      clearScreen()
      dispatch({ type: "TOGGLE_VERBOSE" })
      dispatch({ type: "NOTICE", message: state.verbose ? "Detail mode off" : "Detail mode on" })
      return
    }
    // Ctrl+V pastes an image from the OS clipboard as an `@<path>` mention so it
    // flows through the attachment pipeline. Gated on no-overlay so it never
    // fires while a modal owns input.
    if (key.ctrl && input === "v" && !overlayOpen) {
      void pasteClipboardImage()
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
      if (busy) agent.abort()
      abortRuntime()
    }
  })

  const banner = (
    <Banner
      version={VERSION}
      provider={state.config.provider}
      model={state.config.model}
      cwd={state.config.cwd}
    />
  )

  // Startup phase: welcome banner + the "do you trust this folder?" gate only —
  // no transcript/composer/footer until the user proceeds.
  if (state.phase === "startup") {
    return (
      <ThemeProvider palette={themePalette}>
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
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider palette={themePalette}>
      <Box flexDirection="column" width={columns}>
        <Transcript
          cells={state.cells}
          header={banner}
          verbose={state.verbose}
          epoch={state.renderEpoch}
        />
        <Inflight inflight={state.inflight} verbose={state.verbose} />
        <WorkflowRunPanel run={state.workflowRun} />
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
              const m = (state.overlay as { options: (typeof PERMISSION_MODES)[number][] }).options[
                i
              ]
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
              if (
                lvl !== "off" &&
                !modelSupportsEffort(state.config.provider, state.config.model)
              ) {
                dispatch({
                  type: "NOTICE",
                  message: `Saved. Note: ${state.config.model ?? "the current model"} doesn't support thinking levels — it applies when you switch to a reasoning model (Opus 4.5+, Sonnet 4.6, o-series, …).`,
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
              label: p.id,
              hint: p.configured ? p.auth : "not configured",
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
            model={state.config.model}
            totals={state.sessionTotals}
            contextWindow={state.modelMeta?.contextWindow}
            pricing={state.modelMeta?.pricing}
            usageHistory={state.usageHistory}
            toolStats={state.toolStats}
            onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
          />
        )}
        {state.overlay.kind === "limits" && (
          <LimitsPanel
            snapshots={state.overlay.snapshots}
            analysis={state.overlay.analysis}
            now={state.overlay.now}
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
        {!overlayOpen && (
          <Input
            input={state.input}
            dispatch={dispatch}
            onSubmit={handleSubmit}
            onHistoryPush={persistHistory}
            // Stay active during a turn / goal / loop run so a `btw` steer can be
            // typed mid-stream — `handleSubmit` queues it instead of sending.
            disabled={false}
            cwd={state.config.cwd}
            listDir={listDir}
            mentionProviders={mentionProviders}
            width={columns}
            popupRows={popupRows}
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
          turnStatus={state.turnStatus}
          activity={state.activity}
          verbose={state.verbose}
          planTitle={state.lastPlan ? planTitle(state.lastPlan.raw) : undefined}
          steerCount={state.steerQueue.length}
          subagentRunning={runningSubagents(state.inflight.tools)}
        />
      </Box>
    </ThemeProvider>
  )
}
