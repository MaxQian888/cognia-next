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
import React, { useCallback, useReducer } from "react"
import { Box, useApp, useInput } from "ink"

import { Footer } from "./Footer"
import { Inflight } from "./Inflight"
import { Input } from "./Input"
import { SelectList } from "./SelectList"
import { Transcript } from "./Transcript"
import { listSessions, type ReadDir } from "./sessions-list"
import { PermissionOverlay } from "./overlays/PermissionOverlay"
import { Help } from "./overlays/Help"
import { UsagePanel } from "./overlays/UsagePanel"
import { collectModelOptions } from "./model-options"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { isBusy } from "../state/selectors"
import { transcriptToCells } from "../format/transcript"
import { useAgentSession, type CreateSession } from "../hooks/useAgentSession"
import { mintSessionId } from "../../agent/run"
import { readTranscript, type TranscriptFs } from "../../agent/transcript"
import { resolveHome } from "../../config/load"
import { PERMISSION_MODES } from "../../config/schema"
import type { ListDir } from "../commands/file-completer"
import type { ResolvedConfig } from "../../config/schema"

const DOUBLE_CTRL_C_MS = 1000

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
}: AppProps) {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(tuiReducer, undefined, () =>
    createInitialState(config, sessionId)
  )
  const agent = useAgentSession({ config: state.config, dispatch, createSession })
  const busy = isBusy(state)
  const overlayOpen = state.overlay.kind !== "none"

  const doExit = useCallback(() => {
    dispatch({ type: "EXIT" })
    if (onExit) onExit()
    else exit()
  }, [exit, onExit])

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

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.startsWith("/")) {
        void agent.send(text)
        return
      }
      const [word, ...restParts] = text.slice(1).split(/\s+/)
      const cmd = word.toLowerCase()
      const rest = restParts.join(" ")
      switch (cmd) {
        case "exit":
        case "quit":
          doExit()
          break
        case "clear":
        case "new":
          void agent.clear(mintId())
          break
        case "help":
          dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "help" } })
          break
        case "usage":
          dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
          break
        case "model": {
          const options = collectModelOptions(state.config)
          if (options.length === 0) {
            dispatch({
              type: "NOTICE",
              message: "No models configured. Set one with `cognia-agent config set model <id>`.",
            })
          } else {
            dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "model", options, index: 0 } })
          }
          break
        }
        case "mode":
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: { kind: "mode", options: [...PERMISSION_MODES], index: 0 },
          })
          break
        case "sessions":
          openSessions()
          break
        case "handoff":
          void Promise.resolve(pushHandoff?.(state.sessionId)).then(() =>
            dispatch({ type: "NOTICE", message: "Pushed this session to the desktop app." })
          )
          break
        default:
          dispatch({
            type: "NOTICE",
            message: `Unknown command /${cmd}${rest ? " " + rest : ""} — /help for the list`,
          })
      }
    },
    [agent, doExit, mintId, openSessions, pushHandoff, state.config, state.sessionId]
  )

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const at = now()
      if (state.lastCtrlCAt && at - state.lastCtrlCAt < DOUBLE_CTRL_C_MS) {
        doExit()
      } else {
        dispatch({ type: "CTRL_C", at })
        if (busy) agent.abort()
      }
      return
    }
    // Esc only acts here when no overlay is open (overlays own their Esc).
    if (key.escape && !overlayOpen && busy) {
      agent.abort()
    }
  })

  return (
    <Box flexDirection="column">
      <Transcript cells={state.cells} />
      <Inflight inflight={state.inflight} />
      {state.overlay.kind === "permission" && (
        <PermissionOverlay
          req={state.overlay.req}
          choices={state.overlay.choices}
          index={state.overlay.index}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onResolve={(decision) => agent.resolvePermission(decision)}
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
            void agent.switchMode(m)
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
      {state.overlay.kind === "usage" && (
        <UsagePanel
          usage={state.usage}
          model={state.config.model}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "help" && (
        <Help onClose={() => dispatch({ type: "OVERLAY_CLOSE" })} />
      )}
      {!overlayOpen && (
        <Input
          input={state.input}
          dispatch={dispatch}
          onSubmit={handleSubmit}
          disabled={busy}
          cwd={state.config.cwd}
          listDir={listDir}
        />
      )}
      <Footer config={state.config} usage={state.usage} turnStatus={state.turnStatus} />
    </Box>
  )
}
