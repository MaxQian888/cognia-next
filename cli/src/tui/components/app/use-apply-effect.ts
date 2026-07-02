import { useCallback } from "react"
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
import { VERSION } from "../../../version"
import {
  setConfigValue,
  setAdditionalRoots,
  setCustomTheme,
  setStringArrayConfig,
  setKeybindings,
  setBooleanFlag,
} from "../../../config/mutate"
import { PLAN_REFINE_PROMPT } from "../../runtime/plan"
import type { McpProbeCache } from "../../runtime/mcp-cache"
import { clipboardFailureMessage, type CopyResult } from "../../clipboard"
import type { runGoalStreaming } from "../../runtime/goal-run"
import type { runLoopStreaming } from "../../runtime/loop-run"
import type { runFixStreaming } from "../../runtime/fix-run"
import type { CommandEffect } from "../../commands/types"
import type { TuiState, TuiAction } from "../../state/types"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { BashFailure } from "./use-bash-shellout"
import type { ShellResult, RunShellOpts } from "../../../agent/run-shell"
import type {
  ResolvedConfig,
  ResolvedNotices,
  StatusBarConfig,
  MascotConfig,
  EditorConfig,
} from "../../../config/schema"

/**
 * The `/mcp` actions that change the RESOLVED send options (the server set fed to
 * the SDK, or the disabled-tool overlay unioned into `disallowedTools`). Only
 * these justify an `agent.invalidate()` — every other `/mcp` action is read-only
 * (panel/list/show/tools/resources/prompts/reconnect/auth/logout/presets) and
 * must leave the live session's cached options (and its MCP connections) intact.
 */
const MCP_OPTION_MUTATING_ACTIONS = new Set(["add", "remove", "toggle", "enable", "disable"])

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
  pushHandoff?: (sessionId: string) => void | Promise<void>
  openSessions: () => void
  resumeMostRecent: () => void
  runBash: (command: string) => void
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
  /** Arm/clear the shared runtime-abort controller (a ref owned by App). Passed
   * as accessors rather than the raw ref so the hook never mutates a prop. */
  setRuntimeAbort: (controller: AbortController | null) => void
  getRuntimeAbort: () => AbortController | null
  /** Shared MCP probe cache (App-owned) — threaded to the runtime so command-path
   * `/mcp` mutators keep it coherent with the panel. */
  mcpProbeCache: McpProbeCache
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
  } = deps
  return useCallback(
    (effect: CommandEffect) => {
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
        case "goalRun": {
          // Start a self-driving goal that streams every turn into the transcript
          // (reuses lib/goal: createGoal + judge + handleTurnComplete). Esc aborts
          // the controller, ending the run. `btw` steers it via `takeSteer`.
          const controller = new AbortController()
          setRuntimeAbort(controller)
          void startGoalRun(effect.objective, {
            send: agent.send,
            dispatch,
            sessionId: state.sessionId,
            config: state.config,
            signal: controller.signal,
            takeSteer,
            firer: createCliLifecycleFirer({ home, osHome }),
          }).finally(() => {
            if (getRuntimeAbort() === controller) setRuntimeAbort(null)
            persistDb()
          })
          break
        }
        case "loop": {
          // Run a self-paced or interval loop, streaming each turn (reuses
          // lib/loop). Esc aborts the controller; `btw` steers via `takeSteer`.
          const controller = new AbortController()
          setRuntimeAbort(controller)
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
            if (getRuntimeAbort() === controller) setRuntimeAbort(null)
            persistDb()
          })
          break
        }
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
          const controller = new AbortController()
          setRuntimeAbort(controller)
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
            ...(state.commitDraft ? { commitDraft: state.commitDraft } : {}),
            ...(state.prDraft ? { prDraft: state.prDraft } : {}),
            inflightTools: state.inflight.tools,
            mcpProbeCache,
          })
            .catch((err: unknown) =>
              dispatch({
                type: "NOTICE",
                message: `Runtime error: ${err instanceof Error ? err.message : String(err)}`,
              })
            )
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
      persistEditor,
      openInEditorFn,
      pushHandoff,
      resumeMostRecent,
      runBash,
      takeLastFailedBash,
      runShell,
      startGoalRun,
      startLoopRun,
      startFixRun,
      syncAndRefreshModelOverlay,
      takeSteer,
      changeCwd,
      scrollReset,
      cursor,
      fullscreen,
      screen,
      notices,
      dispatch,
      setRuntimeAbort,
      getRuntimeAbort,
      mcpProbeCache,
      state.config,
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
