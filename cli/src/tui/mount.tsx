/**
 * Mounts the Ink TUI for `cognia-agent chat`. The ink `render` is injectable so
 * the wiring is unit-testable without a real terminal.
 */
import os from "node:os"
import React from "react"
import { render as inkRender } from "ink"

import { App } from "./components/App"
import { loadHistory } from "./input/history-store"
import { mintSessionId } from "../agent/run"
import { resolveActiveModel } from "../config/active-model"
import { resolveHome } from "../config/load"
import { isTrusted } from "../config/trusted-folders"
import type { CreateSession } from "./hooks/useAgentSession"
import type { ResolvedConfig } from "../config/schema"

export interface RenderTuiDeps {
  config: ResolvedConfig
  createSession?: CreateSession
  pushHandoff?: (sessionId: string) => void | Promise<void>
  sessionId?: string
  render?: typeof inkRender
}

export async function renderTui(deps: RenderTuiDeps): Promise<number> {
  const sessionId = deps.sessionId ?? mintSessionId()
  const render = deps.render ?? inkRender
  // Show the startup trust gate the first time the CLI runs in this folder; skip
  // it once the folder has been confirmed (persisted in ~/.cognia).
  const home = resolveHome(process.env, os.homedir())
  const trusted = isTrusted(home, deps.config.cwd)
  // Pin the displayed model to the one the agent will actually run with, so the
  // banner/footer/`/model` list are in sync from the very first frame — not just
  // after the user switches providers once (which is what used to set it).
  const config: ResolvedConfig = { ...deps.config, model: resolveActiveModel(deps.config) }
  // Seed the composer history from the persisted store so ↑ recalls lines from
  // earlier sessions (best-effort — a missing/corrupt file yields []).
  const initialHistory = loadHistory(home)
  const instance = render(
    <App
      config={config}
      sessionId={sessionId}
      createSession={deps.createSession}
      pushHandoff={deps.pushHandoff}
      trusted={trusted}
      initialHistory={initialHistory}
    />
  )
  await instance.waitUntilExit()
  return 0
}
