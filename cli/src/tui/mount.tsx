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
  // Enable bracketed paste so a multi-line / huge paste arrives atomically
  // (the composer reassembles it via `createPasteParser` and collapses it to a
  // placeholder). Guarded for non-TTY (piped stdout in CI). Disabled on exit so
  // we never leave the user's terminal in bracketed-paste mode.
  enableBracketedPaste()
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
  try {
    await instance.waitUntilExit()
  } finally {
    disableBracketedPaste()
  }
  return 0
}

/** The terminal escape that turns bracketed paste ON. */
const BRACKETED_PASTE_ON = "\x1b[?2004h"
/** The terminal escape that turns bracketed paste OFF. */
const BRACKETED_PASTE_OFF = "\x1b[?2004l"

/** Enable bracketed paste on the real terminal (no-op when stdout isn't a TTY). */
export function enableBracketedPaste(out: NodeJS.WriteStream = process.stdout): void {
  if (out.isTTY) out.write(BRACKETED_PASTE_ON)
}

/** Disable bracketed paste on the real terminal (no-op when stdout isn't a TTY). */
export function disableBracketedPaste(out: NodeJS.WriteStream = process.stdout): void {
  if (out.isTTY) out.write(BRACKETED_PASTE_OFF)
}
