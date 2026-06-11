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
import React, { useCallback, useReducer, useRef } from "react"
import { Box, useApp, useInput } from "ink"

import { Banner } from "./Banner"
import { Footer } from "./Footer"
import { Inflight } from "./Inflight"
import { Input } from "./Input"
import { SelectList } from "./SelectList"
import { StartupGate } from "./StartupGate"
import { Transcript } from "./Transcript"
import type { ListDirs } from "./FolderPicker"
import { trustFolder as defaultTrustFolder } from "../../config/trusted-folders"
import { listSessions, type ReadDir } from "./sessions-list"
import { PermissionOverlay } from "./overlays/PermissionOverlay"
import { Help } from "./overlays/Help"
import { UsagePanel } from "./overlays/UsagePanel"
import { StatusPanel } from "./overlays/StatusPanel"
import { catalogModelIds } from "@/lib/ai/model-options"

import { collectModelOptions } from "./model-options"
import { collectProviderOptions } from "../commands/provider-options"
import { FormOverlay } from "./overlays/FormOverlay"
import { dispatchCommand } from "../commands/dispatch"
import { cyclePermissionMode } from "../input/mode-cycle"
import { parseBang, formatBashResult } from "../commands/bash-shellout"
import { runShell as defaultRunShell, type ShellResult } from "../../agent/run-shell"
import { registerFeatureCommands } from "../commands"
import { runRuntimeRequest } from "../runtime"
import { ensureCliDb } from "../../db/bootstrap"
import { createForm, formSubmit } from "../state/form"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { isBusy } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { copyToClipboard } from "../clipboard"
import { appendHistory } from "../input/history-store"
import { useAgentSession, type CreateSession } from "../hooks/useAgentSession"
import { addToolApproval } from "../../agent/tool-approvals"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import { mintSessionId } from "../../agent/run"
import { readTranscript, type TranscriptFs } from "../../agent/transcript"
import { resolveHome } from "../../config/load"
import { setConfigValue, setStatusBarConfig } from "../../config/mutate"
import { PERMISSION_MODES } from "../../config/schema"
import { VERSION } from "../../version"
import type { ListDir } from "../commands/file-completer"
import type { CommandEffect } from "../commands/types"
import type { ConfigMenuRow } from "../commands/config-menu"
import type { SelectItem } from "../state/types"
import type { ResolvedConfig, StatusBarConfig } from "../../config/schema"

const DOUBLE_CTRL_C_MS = 1000

// Clear the screen + scrollback + home the cursor. `<Static>` writes the
// transcript straight into the terminal scrollback (it is never re-rendered), so
// emptying the cell array on `/clear` does NOT erase what is already on screen —
// only wiping the terminal does. Ink repaints its (now empty) frame on top.
const CLEAR_SCREEN = "\x1B[2J\x1B[3J\x1B[H"

function clearTerminal(): void {
  if (process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN)
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
  /** Composer history to seed (oldest → newest); defaults to none. `mount.tsx`
   * passes the persisted `~/.cognia/history.json`. */
  initialHistory?: string[]
  /** Persist a newly-submitted composer line to the history store; defaults to
   * the real appender. Injected as a no-op by tests. */
  persistHistory?: (entry: string) => void
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
  readdir,
  transcriptFs,
  copyClipboard = copyToClipboard,
  persistConfig,
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
  initialHistory = [],
  persistHistory = (entry) => {
    try {
      appendHistory(home, entry)
    } catch {
      // best-effort — a read-only home shouldn't break the turn.
    }
  },
}: AppProps) {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(tuiReducer, undefined, () =>
    createInitialState(config, sessionId, trusted, initialHistory)
  )
  const agent = useAgentSession({ config: state.config, dispatch, createSession })
  const busy = isBusy(state)
  const overlayOpen = state.overlay.kind !== "none"
  // Abort controller for the active background runtime run (goal/workflow/…).
  const runtimeAbort = useRef<AbortController | null>(null)

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
        case "loop": {
          // Repeat the prompt as up to `max` ordinary chat turns — each streams
          // into the transcript via the same `agent.send` path. Esc aborts the
          // controller (and the in-flight turn), ending the loop.
          const controller = new AbortController()
          runtimeAbort.current = controller
          const label = effect.prompt.length > 40 ? `${effect.prompt.slice(0, 39)}…` : effect.prompt
          dispatch({ type: "ACTIVITY_START", kind: "loop", label, max: effect.max })
          void (async () => {
            let done = 0
            try {
              for (let i = 0; i < effect.max; i++) {
                if (controller.signal.aborted) break
                dispatch({ type: "ACTIVITY_PROGRESS", turns: i + 1 })
                await agent.send(effect.prompt)
                done += 1
              }
              dispatch({
                type: "ACTIVITY_END",
                status: "done",
                summary: `Loop ${controller.signal.aborted ? "stopped" : "finished"} after ${done} turn${done === 1 ? "" : "s"}.`,
              })
            } catch (err) {
              dispatch({
                type: "ACTIVITY_END",
                status: "error",
                summary: `Loop error: ${err instanceof Error ? err.message : String(err)}`,
              })
            } finally {
              if (runtimeAbort.current === controller) runtimeAbort.current = null
            }
          })()
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
            roots,
            version: VERSION,
            usage: state.usage,
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
      mintId,
      openSessions,
      persistDb,
      persistStatusBar,
      pushHandoff,
      resumeMostRecent,
      state.config,
      state.sessionId,
      state.usage,
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

  const handleSubmit = useCallback(
    (text: string) => {
      const bang = parseBang(text)
      if (bang !== null) {
        runBash(bang)
        return
      }
      if (!text.startsWith("/")) {
        void agent.send(text)
        return
      }
      runCommandLine(text)
    },
    [agent, runBash, runCommandLine]
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
        doExit()
      } else {
        dispatch({ type: "CTRL_C", at })
        if (busy) agent.abort()
        abortRuntime()
      }
      return
    }
    // During the startup gate, only Ctrl+C (above) is honored — the gate owns
    // its own keys.
    if (state.phase === "startup") return
    // Ctrl+R toggles tool/thinking output for the whole transcript. The
    // composer ignores unhandled ctrl chords, and overlays own input while open,
    // so this only fires in the normal chat view.
    if (key.ctrl && input === "r" && !overlayOpen) {
      dispatch({ type: "TOGGLE_COLLAPSE_ALL" })
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
      <Box flexDirection="column">
        {banner}
        <StartupGate
          cwd={state.config.cwd}
          onTrust={trustCwd}
          onChangeCwd={changeCwd}
          listDirs={listDirs}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Transcript cells={state.cells} header={banner} />
      <Inflight inflight={state.inflight} />
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
          items={state.overlay.options.map((m) => ({ label: m }))}
          index={state.overlay.index}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={(i) => {
            const m = (state.overlay as { options: string[] }).options[i]
            persist("model", m)
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
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={(i) => {
            const m = (state.overlay as { options: (typeof PERMISSION_MODES)[number][] }).options[i]
            persist("permissionMode", m)
            void agent.switchMode(m)
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
            if (defaultModel) persist("model", defaultModel)
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
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "help" && (
        <Help onClose={() => dispatch({ type: "OVERLAY_CLOSE" })} />
      )}
      {state.overlay.kind === "status" && (
        <StatusPanel
          report={state.overlay.report}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {!overlayOpen && (
        <Input
          input={state.input}
          dispatch={dispatch}
          onSubmit={handleSubmit}
          onHistoryPush={persistHistory}
          disabled={busy}
          cwd={state.config.cwd}
          listDir={listDir}
        />
      )}
      <Footer
        config={state.config}
        usage={state.usage}
        totals={state.sessionTotals}
        turnStatus={state.turnStatus}
        activity={state.activity}
      />
    </Box>
  )
}
