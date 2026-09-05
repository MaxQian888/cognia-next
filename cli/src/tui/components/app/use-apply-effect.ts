import { useCallback, useEffect, useRef } from "react"
import fs from "node:fs"
import nodePath from "node:path"
import type { Dispatch } from "react"

import { createForm } from "../../state/form"
import { createCliLifecycleFirer } from "../../runtime/lifecycle-firer"
import { computeAddDir } from "../../runtime/add-dir"
import { buildBashAnalysisPrompt } from "../../commands/bash-shellout"
import { detectEditor, editorInfo, type openInEditor } from "../../runtime/editor"
import { buildGitDiffDoc } from "../../runtime/git-diff"
import { applyMouseMode, type ScreenStream } from "../../screen"
import { runRuntimeRequest } from "../../runtime"
import { CliDbSnapshotError } from "../../../db/bootstrap"
import { VERSION } from "../../../version"
import {
  setConfigValue,
  setAdditionalRoots,
  setCustomTheme,
  setGitWorkflowConfig,
  setStringArrayConfig,
  setKeybindings,
  setBooleanFlag,
} from "../../../config/mutate"
import { PLAN_REFINE_PROMPT } from "../../runtime/plan"
import type { McpProbeCache } from "../../runtime/mcp-cache"
import { clipboardFailureMessage, type CopyResult } from "../../clipboard"
import type { runGoalStreaming } from "../../runtime/goal-run"
import type { runLoopStreaming, LoopContinuation } from "../../runtime/loop-run"
import type { runFixStreaming } from "../../runtime/fix-run"
import type { CommandEffect } from "../../commands/types"
import type { TuiState, TuiAction } from "../../state/types"
import {
  effectivePermissionMode,
  supportsFeature,
  unsupportedFeatureMessage,
} from "../../runtime/backend-capabilities"
import { planPermissionModeSwitch } from "../../runtime/permission-mode-switch"
import { requiresAcknowledgement } from "../../state/permission-mode-meta"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { BashFailure } from "./use-bash-shellout"
import type { ShellResult, RunShellOpts } from "../../../agent/run-shell"
import {
  DEFAULT_MOUSE_MODE,
  DEFAULT_SELECTION_MODE,
  type ResolvedConfig,
  type ResolvedNotices,
  type StatusBarConfig,
  type MascotConfig,
  type EditorConfig,
  type SelectionMode,
} from "../../../config/schema"
import type { SelectionController } from "../../selection/selection-controller"

/**
 * The `/mcp` actions that change the RESOLVED send options (the server set fed to
 * the SDK, or the disabled-tool overlay unioned into `disallowedTools`). Only
 * these justify an `agent.invalidate()` — every other `/mcp` action is read-only
 * (panel/list/show/tools/resources/prompts/reconnect/auth/logout/presets) and
 * must leave the live session's cached options (and its MCP connections) intact.
 */
const MCP_OPTION_MUTATING_ACTIONS = new Set(["add", "remove", "toggle", "enable", "disable"])

/** What each `/select` mode does, in one line — the notice after a switch. */
const SELECTION_NOTICES: Record<SelectionMode, string> = {
  off: "Selection: off — the terminal's own selection is back in charge.",
  manual: "Selection: manual — drag to highlight, then copy with the copy-selection chord.",
  "auto-copy": "Selection: auto-copy — a drag copies itself the moment you let go.",
}

export interface ApplyEffectDeps {
  agent: AgentSessionApi
  dispatch: Dispatch<TuiAction>
  state: TuiState
  home: string
  osHome: string
  mintId: () => string
  clearScreen: () => void
  scrollReset: () => void
  cursor: TranscriptCursor
  copyClipboard: (text: string) => Promise<CopyResult>
  notices: ResolvedNotices
  pushHandoff?: (sessionId: string) => boolean | Promise<boolean>
  attachHost?: (options: {
    targetId: string
    sessionId?: string
    accountId?: string
  }) => Promise<string>
  detachHost?: () => Promise<string>
  hostSyncStatus?: () => Promise<string>
  openSessions: () => void
  /** Open the `/model` switcher — backend-aware, so it may query the external
   * agent for its own catalog before the overlay can be built. */
  openModelPicker: () => void
  resumeMostRecent: () => void
  /** Resume a specific past session by id (`/resume <id>`); the App validates
   * the id against the session store and notices when it's unknown. */
  resumeSession: (id: string) => void
  runBash: (command: string) => void
  /** Kill a live `!command` run by cell id (`/bashes kill`). */
  killBash: (id: string) => boolean
  /** Re-foreground a backgrounded `!command` run (`/bashes fg`). */
  foregroundBash: (id: string) => boolean
  takeLastFailedBash: () => BashFailure | null
  persistStatusBar: (home: string, patch: StatusBarConfig) => void
  persistMascot: (home: string, patch: MascotConfig) => void
  persistEditor: (home: string, patch: EditorConfig) => void
  openInEditorFn: typeof openInEditor
  runShell: (command: string, opts: RunShellOpts) => Promise<ShellResult>
  persist: (key: string, value: string) => boolean
  persistDb: () => void
  fullscreen: boolean
  screen: ScreenStream
  /** The live in-app selection, when the frame buffer is available. `/select`
   * drops any painted highlight through it before switching modes. */
  selectionRef: { current: SelectionController | null }
  startGoalRun: typeof runGoalStreaming
  startLoopRun: typeof runLoopStreaming
  startFixRun: typeof runFixStreaming
  syncAndRefreshModelOverlay: () => void
  takeSteer: () => string | null
  doExit: () => void
  /** Switch the session working directory (owned by App: trusts the folder,
   * dispatches `SET_CWD`, and re-resolves SendOptions). The effect handler
   * validates the path before calling this. */
  changeCwd: (dir: string) => void
  /** Reclaim the live external-agent process (App-owned `connectionRef`). Called
   * on a `/backend` switch to the built-in agent, where nothing reconnects, so
   * the old external process would otherwise leak until exit. On an external →
   * external switch this is NOT called: `connectBackend`'s own idempotent
   * re-register reclaims the old process as it comes back up, and an explicit
   * removal here would race that re-register. */
  reclaimBackend: () => void
  /** Arm/clear the shared runtime-abort controller (a ref owned by App). Passed
   * as accessors rather than the raw ref so the hook never mutates a prop. */
  setRuntimeAbort: (controller: AbortController | null) => void
  getRuntimeAbort: () => AbortController | null
  /** Shared MCP probe cache (App-owned) — threaded to the runtime so command-path
   * `/mcp` mutators keep it coherent with the panel. */
  mcpProbeCache: McpProbeCache
  /** Mode injected by a session-only CLI flag such as `--bypass`. */
  sessionOnlyPermissionMode?: ResolvedConfig["permissionMode"]
}

type DrivenEffect = Extract<CommandEffect, { kind: "goalRun" | "loop" }>
interface DrivenJob {
  effect: DrivenEffect
  sessionId: string
  controller: AbortController
  pending: Promise<void>
  settled: boolean
  disposition: "running" | "paused" | "resuming" | "stopped"
  continuation: LoopContinuation
}

/**
 * Interpret a pure {@link CommandEffect} produced by the dispatcher. The only
 * place the slash commands' side effects happen — keeps every handler
 * unit-testable. Lifted out of {@link App}; the memoization deps array is
 * preserved exactly so `runCommandLine`/`activateSettings` keep their identity.
 */
export function useApplyEffect(deps: ApplyEffectDeps): (effect: CommandEffect) => void {
  const {
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
    attachHost,
    detachHost,
    hostSyncStatus,
    openSessions,
    openModelPicker,
    resumeMostRecent,
    resumeSession,
    runBash,
    killBash,
    foregroundBash,
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
    selectionRef,
    startGoalRun,
    startLoopRun,
    startFixRun,
    syncAndRefreshModelOverlay,
    takeSteer,
    doExit,
    changeCwd,
    reclaimBackend,
    setRuntimeAbort,
    getRuntimeAbort,
    mcpProbeCache,
    sessionOnlyPermissionMode,
  } = deps
  const drivenJob = useRef<DrivenJob | null>(null)
  useEffect(
    () => () => {
      const job = drivenJob.current
      if (job?.sessionId === state.sessionId) {
        job.controller.abort("pause")
        drivenJob.current = null
      }
    },
    [state.sessionId]
  )
  return useCallback(
    (effect: CommandEffect) => {
      const notice = (message: string) => dispatch({ type: "NOTICE", message })
      const launchDriven = (
        next: DrivenEffect,
        resume = false,
        continuation: LoopContinuation = {}
      ) => {
        const current = drivenJob.current
        if (current || (getRuntimeAbort() && !getRuntimeAbort()!.signal.aborted)) {
          notice("A foreground run already exists; pause, resume, or stop it first.")
          return
        }
        const controller = new AbortController()
        const job: DrivenJob = {
          effect: next,
          sessionId: state.sessionId,
          controller,
          pending: Promise.resolve(),
          settled: false,
          disposition: "running",
          continuation,
        }
        drivenJob.current = job
        setRuntimeAbort(controller)
        const onAbort = () => {
          if (drivenJob.current === job) agent.abort()
        }
        controller.signal.addEventListener("abort", onAbort, { once: true })
        const emit: Dispatch<TuiAction> = (action) => {
          if (drivenJob.current === job) {
            if (
              action.type === "ACTIVITY_END" &&
              action.status === "error" &&
              job.disposition === "running"
            ) {
              job.disposition = "paused"
            }
            dispatch(action)
          }
        }
        const common = {
          send: agent.send,
          dispatch: emit,
          sessionId: state.sessionId,
          config: state.config,
          signal: controller.signal,
          takeSteer,
        }
        job.pending = (async () => {
          if (next.kind === "goalRun") {
            await startGoalRun(next.objective, {
              ...common,
              resume,
              firer: createCliLifecycleFirer({ home, osHome }),
            })
          } else {
            await startLoopRun({
              ...next,
              ...common,
              continuation,
              ...(resume ? { action: "resume" as const } : {}),
            })
          }
        })()
          .catch((error: unknown) => {
            emit({
              type: "ACTIVITY_END",
              status: "error",
              summary: `Run failed: ${error instanceof Error ? error.message : String(error)}`,
            })
          })
          .finally(() => {
            job.settled = true
            controller.signal.removeEventListener("abort", onAbort)
            if (getRuntimeAbort() === controller) setRuntimeAbort(null)
            if (drivenJob.current === job && job.disposition === "running") {
              if (controller.signal.aborted) job.disposition = "paused"
              else drivenJob.current = null
            }
            persistDb()
          })
      }
      const controlDriven = async (
        kind: "goalRun" | "loop",
        action: "pause" | "resume" | "stop"
      ) => {
        const job = drivenJob.current
        if (!job || job.sessionId !== state.sessionId || job.effect.kind !== kind) {
          if (kind === "goalRun" && action === "resume" && !job) {
            launchDriven({ kind: "goalRun", objective: "" }, true)
          } else {
            notice(
              `No ${action === "resume" ? "paused" : "active"} ${kind === "loop" ? "loop" : "goal"} run in this session.`
            )
          }
          return
        }
        if (action === "resume") {
          if (
            job.disposition !== "paused" &&
            !(job.disposition === "running" && job.controller.signal.aborted)
          ) {
            notice("Run is not paused.")
            return
          }
          job.disposition = "resuming"
          await job.pending
          if (drivenJob.current !== job || job.disposition !== "resuming") return
          const other = getRuntimeAbort()
          if (other && other !== job.controller && !other.signal.aborted) {
            job.disposition = "paused"
            notice("Another foreground action is running; finish it before resuming.")
            return
          }
          drivenJob.current = null
          launchDriven(job.effect, true, job.continuation)
          return
        }
        if (action === "pause" && job.disposition !== "running") {
          notice("Run is already paused or changing state.")
          return
        }
        if (job.disposition === "stopped") {
          notice("Run is already stopping.")
          return
        }
        job.disposition = action === "pause" ? "paused" : "stopped"
        const needsPersistedStop =
          action === "stop" && (job.controller.signal.aborted || job.settled)
        job.controller.abort(action)
        await job.pending
        if (drivenJob.current !== job) return
        try {
          if (needsPersistedStop) {
            if (job.effect.kind === "loop") {
              await startLoopRun({
                ...job.effect,
                continuation: job.continuation,
                action: "stop",
                send: agent.send,
                dispatch,
                sessionId: state.sessionId,
                config: state.config,
                signal: new AbortController().signal,
              })
            } else {
              await runRuntimeRequest(
                { feature: "goal", action: "stop" },
                {
                  dispatch,
                  sessionId: state.sessionId,
                  config: state.config,
                  signal: new AbortController().signal,
                  home,
                  osHome,
                  roots: [state.config.cwd, home],
                  version: VERSION,
                }
              )
            }
          }
        } catch (error) {
          if (drivenJob.current === job) job.disposition = "paused"
          throw error
        }
        if (drivenJob.current !== job) return
        if (action === "stop" && drivenJob.current === job) drivenJob.current = null
        notice(`${kind === "loop" ? "Loop" : "Goal"} ${action === "pause" ? "paused" : "stopped"}.`)
        persistDb()
      }

      // Recolour the committed scrollback after a display-only change (theme).
      // In scrollback mode the transcript + banner live inside Ink's `<Static>`,
      // which freezes already-emitted rows and never re-renders them in place —
      // so a new palette reaches only NEW cells and the switch looks like a no-op.
      // Clearing the screen and bumping `renderEpoch` remounts `<Static>` so every
      // cell re-prints with the active palette (same pattern as resize recovery /
      // the clear-screen chord). Fullscreen renders the transcript live and
      // recolours on its own, so the repaint is a no-op there — skip it.
      const repaintScrollback = () => {
        if (fullscreen) return
        clearScreen()
        dispatch({ type: "REPAINT" })
      }
      switch (effect.kind) {
        case "none":
          break
        case "notice":
          dispatch({ type: "NOTICE", message: effect.message })
          break
        case "openOverlay":
          dispatch({ type: "OVERLAY_OPEN", overlay: effect.overlay })
          // The `/model` command opens with a synchronous snapshot of the model
          // list; for OpenRouter, refresh it once the live catalog sync lands.
          if (effect.overlay.kind === "model") syncAndRefreshModelOverlay()
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
          // `/compact` posts a control message to the built-in sidecar and waits
          // for a boundary event nothing else emits, so on an external backend it
          // used to hang silently. Refuse it outright instead.
          if (!supportsFeature(state.backendCapabilities, "compact")) {
            dispatch({
              type: "NOTICE",
              message: unsupportedFeatureMessage(state.backendCapabilities, "compact"),
              severity: "warn",
            })
            break
          }
          // Light up the PreCompact lifecycle hook (ADR-0040 follow-up) just
          // before the context window is trimmed. Fire-and-forget observational.
          void createCliLifecycleFirer({ home, osHome })(
            "PreCompact",
            {
              agentId: "cli",
              // A CLI-local shell event, not an agent turn.
              agentKind: "system",
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
          if (!pushHandoff) {
            dispatch({
              type: "NOTICE",
              message: "No running Cognia desktop found — open the app, then retry.",
              severity: "warn",
            })
            break
          }
          void Promise.resolve(pushHandoff(state.sessionId))
            .then((ok) =>
              dispatch({
                type: "NOTICE",
                message: ok
                  ? "Pushed this session to the desktop app."
                  : "No running Cognia desktop found — open the app, then retry.",
                ...(ok ? {} : { severity: "warn" as const }),
              })
            )
            .catch((error: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Handoff failed: ${error instanceof Error ? error.message : String(error)}`,
                severity: "error",
              })
            )
          break
        case "attachHost":
          if (!attachHost) {
            dispatch({
              type: "NOTICE",
              message: "Host attachment is unavailable.",
              severity: "warn",
            })
            break
          }
          void attachHost({
            targetId: effect.targetId,
            ...(effect.sessionId ? { sessionId: effect.sessionId } : {}),
            ...(effect.accountId ? { accountId: effect.accountId } : {}),
          })
            .then((message) => dispatch({ type: "NOTICE", message }))
            .catch((error: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Attach failed: ${error instanceof Error ? error.message : String(error)}`,
                severity: "error",
              })
            )
          break
        case "detachHost":
          if (!detachHost) {
            dispatch({
              type: "NOTICE",
              message: "Host attachment is unavailable.",
              severity: "warn",
            })
            break
          }
          void detachHost()
            .then((message) => dispatch({ type: "NOTICE", message }))
            .catch((error: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Detach failed: ${error instanceof Error ? error.message : String(error)}`,
                severity: "error",
              })
            )
          break
        case "hostSyncStatus":
          if (!hostSyncStatus) {
            dispatch({
              type: "NOTICE",
              message: "Host attachment is unavailable.",
              severity: "warn",
            })
            break
          }
          void hostSyncStatus()
            .then((message) => dispatch({ type: "NOTICE", message }))
            .catch((error: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Sync status failed: ${error instanceof Error ? error.message : String(error)}`,
                severity: "error",
              })
            )
          break
        case "modelPicker":
          openModelPicker()
          break
        case "openSessions":
          openSessions()
          break
        case "resumeLast":
          resumeMostRecent()
          break
        case "resumeSession":
          resumeSession(effect.id)
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
                // A CLI-local shell event, not an agent turn.
                agentKind: "system",
                sessionId: state.sessionId,
              },
              { payload: { roots: r.roots } }
            )
          }
          dispatch({ type: "NOTICE", message: r.message })
          break
        }
        case "changeCwd": {
          // Resolve `/cd <dir>` against the live cwd and validate it before
          // switching — App.changeCwd trusts + re-resolves SendOptions but does
          // no validation, so a bad path would silently strand the agent in a
          // non-existent directory.
          const target = nodePath.resolve(state.config.cwd, effect.dir)
          let isDir = false
          try {
            isDir = fs.statSync(target).isDirectory()
          } catch {
            isDir = false
          }
          if (!isDir) {
            dispatch({ type: "NOTICE", message: `Not a directory: ${target}` })
            break
          }
          // Compare against the NORMALIZED current cwd so `/cd .` (or the same
          // path spelled differently) is recognised as a no-op on every platform.
          if (target === nodePath.resolve(state.config.cwd)) {
            dispatch({ type: "NOTICE", message: `Already in ${target}` })
            break
          }
          changeCwd(target)
          dispatch({ type: "NOTICE", message: `Working directory: ${target}` })
          break
        }
        case "runBash":
          runBash(effect.command)
          break
        case "bashKill":
          // The registry owns the success notice; only the miss needs a message
          // (the run settled between the picker opening and the choice).
          if (!killBash(effect.id)) {
            dispatch({ type: "NOTICE", message: "That command is no longer running." })
          }
          break
        case "bashForeground":
          if (!foregroundBash(effect.id)) {
            dispatch({ type: "NOTICE", message: "That command is no longer running." })
          }
          break
        case "analyzeBash": {
          // Diagnose the last failed foreground `!command` with the agent. The
          // captured command + output flow into a single send; clear it after so
          // a second /analyze doesn't re-debug a stale failure.
          const failure = takeLastFailedBash()
          if (!failure) {
            dispatch({ type: "NOTICE", message: "No failed command to analyze." })
            break
          }
          void agent.send(buildBashAnalysisPrompt(failure))
          break
        }
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
        case "openFile": {
          // Resolve the editor from config/env and spawn it; report the outcome.
          const { editor } = detectEditor(process.env, { config: state.config.editor })
          const abs = nodePath.isAbsolute(effect.file)
            ? effect.file
            : nodePath.resolve(state.config.cwd, effect.file)
          void openInEditorFn(abs, { line: effect.line, col: effect.col, editor }).then((ok) =>
            dispatch({
              type: "NOTICE",
              message: ok
                ? `Opened ${effect.file} in ${editor.displayName}`
                : `Couldn't open ${editor.displayName} — file: ${abs}`,
            })
          )
          break
        }
        case "editorInfo": {
          const info = editorInfo(process.env, { config: state.config.editor })
          const lines = [
            `Editor: ${info.editor.displayName} (${info.editor.command}) · source: ${info.source}`,
            `Terminal: ${info.terminalProgram ?? "unknown"}${info.launchedFromEditor ? " · launched from editor" : ""}`,
            `Clickable paths (OSC-8 hyperlinks): ${info.hyperlinks ? "yes" : "no"}`,
          ]
          dispatch({ type: "NOTICE", message: lines.join("\n") })
          break
        }
        case "setEditor":
          dispatch({ type: "SET_EDITOR", editor: { command: effect.command } })
          try {
            persistEditor(home, { command: effect.command })
            dispatch({ type: "NOTICE", message: `Editor: ${effect.command}` })
          } catch {
            dispatch({ type: "NOTICE", message: "Editor updated (couldn't save to config)." })
          }
          break
        case "gitDiff": {
          // Shell `git diff` (+ staged) and render the result in the pager with
          // diff syntax-highlighting. A non-repo / git-missing surfaces as stderr.
          void Promise.all([
            runShell("git --no-pager diff", { cwd: state.config.cwd }),
            runShell("git --no-pager diff --staged", { cwd: state.config.cwd }),
          ])
            .then(([unstaged, staged]) => {
              if (unstaged.code !== 0 && staged.code !== 0) {
                const msg = (unstaged.stderr || staged.stderr).trim()
                dispatch({
                  type: "NOTICE",
                  message: msg || "Couldn't run git diff (not a git repository?).",
                })
                return
              }
              const doc = buildGitDiffDoc(unstaged.stdout, staged.stdout)
              if (!doc) {
                dispatch({ type: "NOTICE", message: "Working tree clean — no changes to show." })
                return
              }
              dispatch({
                type: "OVERLAY_OPEN",
                overlay: { kind: "document", title: doc.title, body: doc.body, format: "markdown" },
              })
            })
            .catch((err: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `git diff failed: ${err instanceof Error ? err.message : String(err)}`,
              })
            )
          break
        }
        case "theme":
          // Live-apply the colour theme (the reducer re-resolves the palette),
          // persist the scalar key, then force a scrollback re-print so the
          // already-printed transcript + banner recolour too. The theme is
          // display-only, so no SendOptions invalidation is needed.
          dispatch({ type: "SET_THEME", theme: effect.theme })
          if (!persist("theme", effect.theme)) {
            dispatch({ type: "NOTICE", message: "Theme updated (couldn't save to config)." })
          } else {
            dispatch({ type: "NOTICE", message: `Theme: ${effect.theme}` })
          }
          repaintScrollback()
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
        case "permissionMode": {
          // The ONE place a permission mode is applied. `/mode`, `/mode <name>`,
          // Shift+Tab and the footer click all arrive here, so the danger-tier
          // acknowledgement cannot be skipped by picking a different entry point.
          const plan = planPermissionModeSwitch({
            next: effect.mode,
            acknowledged: state.bypassAcknowledged,
            ...(effect.force ? { force: true } : {}),
          })
          if (plan.kind === "confirm") {
            dispatch({ type: "OVERLAY_OPEN", overlay: plan.overlay })
            break
          }
          // Reaching apply on a danger-tier mode means the warning was accepted
          // (now or earlier this session) — remember it so cycling back through
          // the mode doesn't re-ask.
          if (requiresAcknowledgement(plan.mode)) dispatch({ type: "BYPASS_ACK" })
          if (!sessionOnlyPermissionMode && !persist("permissionMode", plan.mode)) {
            dispatch({
              type: "NOTICE",
              message: "Permission mode updated (couldn't save to config).",
            })
          }
          void agent.switchMode(plan.mode)
          dispatch({ type: "NOTICE", message: plan.notice })
          // The backend may not be able to enforce what was picked (an `a2a` /
          // `http` / `websocket` agent has no client-side approval loop, so the
          // manager clamps down to `default` before the agent sees it). Saying so
          // is the point — a footer reading `bypassPermissions` while the agent
          // runs under `default` is exactly the silent lie to avoid.
          const effective = effectivePermissionMode(state.backendCapabilities, plan.mode)
          if (effective !== plan.mode) {
            dispatch({
              type: "NOTICE",
              message: `${state.backendCapabilities?.backend ?? "This backend"} can't enforce ${plan.mode} — it runs under ${effective} instead.`,
            })
          }
          break
        }
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
        case "backend": {
          // A backend switch is a lifecycle event, not a setting: the live
          // session belongs to the old agent and its context cannot follow it.
          const previous = state.config.agentBackend ?? "builtin"
          void agent.switchBackend(effect.backend)
          if (!persist("agentBackend", effect.backend)) {
            dispatch({
              type: "NOTICE",
              message: `Backend: ${effect.backend} (couldn't save to config)`,
            })
          }
          // The transcript stays on screen, so say plainly that the new agent
          // cannot see it — the same honesty the restart notice provides.
          dispatch({
            type: "NOTICE",
            message: `Switched from ${previous} to ${effect.backend} — the conversation above is not visible to ${effect.backend}.`,
          })
          // Only an external backend has anything to connect to; the built-in
          // one is already reachable, and routing it through the connect flow
          // would fail on a preset lookup that will never match.
          if (effect.backend !== "builtin") {
            // The reconnect reuses the stable agent id, and connectBackend's own
            // idempotent removeAgent reclaims the previous process as it comes
            // back up — so no explicit reclaim here (which would race that
            // re-register and could remove the freshly-added agent).
            dispatch({ type: "BACKEND_CONNECT_RETRY", backend: effect.backend })
          } else {
            // Switching to the built-in agent: nothing reconnects, so the old
            // external process would otherwise live until exit. Reclaim it now.
            reclaimBackend()
          }
          break
        }
        case "mouse": {
          // Live-apply the mouse model by rewriting the terminal tracking /
          // alternate-scroll escapes in place (only meaningful while fullscreen
          // owns the screen; a no-op on a non-TTY). Then persist the scalar key.
          // Drag reporting rides along whenever in-app selection is on, so the
          // two features stay consistent through a live `/mouse` switch.
          const selecting = (state.config.selection ?? DEFAULT_SELECTION_MODE) !== "off"
          dispatch({ type: "SET_MOUSE", mode: effect.mode })
          if (fullscreen) applyMouseMode(effect.mode, screen, { drag: selecting })
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
        }
        case "selection": {
          // In-app selection reads the mouse, so switching it on/off has to
          // re-issue the tracking escapes: `?1002h` (motion while held) is what
          // makes a drag visible to the TUI at all.
          const configuredMouse = state.config.mouse ?? DEFAULT_MOUSE_MODE
          // `mouse=select` deliberately disables SGR tracking so the terminal
          // can own native selection. That makes in-app drag selection
          // impossible, so enabling `/select` switches to the tracked scroll
          // mode atomically with the selection setting.
          const mouse =
            effect.mode !== "off" && configuredMouse === "select" ? "scroll" : configuredMouse
          if (mouse !== configuredMouse) {
            dispatch({ type: "SET_MOUSE", mode: mouse })
            if (!persist("mouse", mouse)) {
              dispatch({ type: "NOTICE", message: "Mouse mode updated (couldn't save to config)." })
            }
          }
          dispatch({ type: "SET_SELECTION", mode: effect.mode })
          selectionRef.current?.clear()
          if (fullscreen) applyMouseMode(mouse, screen, { drag: effect.mode !== "off" })
          if (!persist("selection", effect.mode)) {
            dispatch({
              type: "NOTICE",
              message: "Selection mode updated (couldn't save to config).",
            })
          } else {
            dispatch({ type: "NOTICE", message: SELECTION_NOTICES[effect.mode] })
          }
          break
        }
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
          repaintScrollback()
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
            } else if (field === "gitProtectedBranches") {
              // Empty clears the key → the resolver's master/main default.
              const arr = effect.value.split(/\s+/).filter(Boolean)
              const gitPatch = { protectedBranches: arr.length ? arr : undefined }
              patch = { git: { ...state.config.git, ...gitPatch } }
              setGitWorkflowConfig(home, gitPatch)
            } else if (field === "gitBaseBranch") {
              // Empty clears the override → /pr auto-detects main → master.
              const branch = effect.value.trim()
              const gitPatch = { baseBranch: branch || undefined }
              patch = { git: { ...state.config.git, ...gitPatch } }
              setGitWorkflowConfig(home, gitPatch)
            }
          } catch {
            dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
          }
          dispatch({ type: "SET_CONFIG_PATCH", patch })
          agent.invalidate()
          dispatch({ type: "NOTICE", message: `Updated ${field}.` })
          break
        }
        case "flag": {
          // Toggle a top-level boolean config flag (e.g. `/route auto on|off`
          // → `autoRoute`). Persist to config.json, live-merge, and re-resolve
          // SendOptions so the next turn honors it.
          try {
            setBooleanFlag(home, effect.key, effect.value)
          } catch {
            dispatch({ type: "NOTICE", message: "Setting changed (couldn't save to config)." })
          }
          dispatch({ type: "SET_CONFIG_PATCH", patch: { [effect.key]: effect.value } })
          agent.invalidate()
          dispatch({
            type: "NOTICE",
            message: `${effect.key} ${effect.value ? "enabled" : "disabled"}.`,
          })
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
        case "goalRun":
        case "loop":
          launchDriven(effect)
          break
        case "loopControl":
          void controlDriven("loop", effect.action).catch((error: unknown) =>
            notice(`Loop control failed: ${String(error)}`)
          )
          break
        case "fixRun": {
          // Bounded test-fix loop: run the tests, feed failures to the agent, and
          // re-run until green or the round cap (reuses runDrivenTurns). Esc aborts
          // the controller (killing an in-flight test + ending the loop); `btw`
          // steers via `takeSteer`.
          const controller = new AbortController()
          setRuntimeAbort(controller)
          void startFixRun({
            send: agent.send,
            dispatch,
            cwd: state.config.cwd,
            signal: controller.signal,
            testCommand: effect.testCommand,
            maxRounds: effect.maxRounds,
            takeSteer,
          }).finally(() => {
            if (getRuntimeAbort() === controller) setRuntimeAbort(null)
            persistDb()
          })
          break
        }
        case "runtime": {
          if (effect.runtime.feature === "goal") {
            const action = effect.runtime.action
            if (
              action === "resume" ||
              ((action === "pause" || action === "stop") && drivenJob.current)
            ) {
              void controlDriven("goalRun", action).catch((error: unknown) =>
                notice(`Goal control failed: ${String(error)}`)
              )
              break
            }
          }
          const controller = new AbortController()
          if (!getRuntimeAbort() || getRuntimeAbort()!.signal.aborted) setRuntimeAbort(controller)
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
            ...(state.backendCapabilities ? { capabilities: state.backendCapabilities } : {}),
            usageHistory: state.usageHistory,
            toolStats: state.toolStats,
            ...(state.rateLimits ? { rateLimits: state.rateLimits } : {}),
            ...(state.initDraft ? { initDraft: state.initDraft } : {}),
            ...(state.commitDraft ? { commitDraft: state.commitDraft } : {}),
            ...(state.prDraft ? { prDraft: state.prDraft } : {}),
            inflightTools: state.inflight.tools,
            mcpProbeCache,
          })
            .catch((err: unknown) => {
              if (err instanceof CliDbSnapshotError) {
                dispatch({
                  type: "TURN_ERROR",
                  message: err.message,
                  title: "Database restore failed",
                })
                return
              }
              dispatch({
                type: "NOTICE",
                message: `Runtime error: ${err instanceof Error ? err.message : String(err)}`,
              })
            })
            .finally(() => {
              if (getRuntimeAbort() === controller) setRuntimeAbort(null)
              // Config-mutating features (MCP / skill / plugin toggles) must
              // re-resolve SendOptions so the change reaches the next turn. But
              // MCP has many READ-ONLY actions (opening the panel, list, show,
              // tools, resources, prompts, reconnect, auth, presets) — those must
              // NOT invalidate, or merely opening `/mcp` would drop the cached
              // options and force the live session to re-connect its MCP servers
              // on the next turn (the "opening /mcp triggers a reload" bug). Only
              // the mutators that change the resolved server / disabled set do.
              const mcpMutates =
                effect.runtime.feature === "mcp" &&
                MCP_OPTION_MUTATING_ACTIONS.has(effect.runtime.action ?? "")
              if (
                mcpMutates ||
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
          void (async () => {
            try {
              await agent.switchMode("plan")
              persist("permissionMode", "plan")
              await agent.send(
                [
                  PLAN_REFINE_PROMPT,
                  ...(state.lastPlan ? ["", "Current reviewed plan:", state.lastPlan.raw] : []),
                  ...(effect.feedback ? ["", "Requested revisions:", effect.feedback] : []),
                ].join("\n")
              )
            } catch (error) {
              dispatch({
                type: "NOTICE",
                message: `Plan refinement failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          })()
          break
        case "exit":
          doExit()
          break
      }
    },
    [
      agent,
      state.lastPlan,
      clearScreen,
      copyClipboard,
      doExit,
      home,
      osHome,
      mintId,
      openSessions,
      openModelPicker,
      persist,
      persistDb,
      persistStatusBar,
      persistMascot,
      persistEditor,
      openInEditorFn,
      pushHandoff,
      attachHost,
      detachHost,
      hostSyncStatus,
      resumeMostRecent,
      resumeSession,
      runBash,
      killBash,
      foregroundBash,
      takeLastFailedBash,
      runShell,
      startGoalRun,
      startLoopRun,
      startFixRun,
      syncAndRefreshModelOverlay,
      takeSteer,
      changeCwd,
      reclaimBackend,
      scrollReset,
      cursor,
      fullscreen,
      screen,
      selectionRef,
      notices,
      dispatch,
      setRuntimeAbort,
      getRuntimeAbort,
      mcpProbeCache,
      sessionOnlyPermissionMode,
      state.config,
      state.backendCapabilities,
      state.bypassAcknowledged,
      state.sessionId,
      state.inflight.tools,
      state.usage,
      state.modelMeta,
      state.usageHistory,
      state.toolStats,
      state.rateLimits,
      state.initDraft,
      state.commitDraft,
      state.prDraft,
      state.cells,
    ]
  )
}
