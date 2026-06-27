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
import { resolveLayoutMode, readLayoutCapability } from "./layout-mode"
import { enterAltScreen, exitAltScreen, applyMouseMode, resetMouse } from "./screen"
import { resetTerminalTitle } from "./terminal-title"
import { DEFAULT_MOUSE_MODE } from "../config/schema"
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
  // Enable bracketed paste so a multi-line / huge paste arrives atomically.
  // Ink ≥7 parses the `ESC[200~ … ESC[201~` span natively and, with no
  // `usePaste` hook mounted, forwards the whole body to `useInput` as a single
  // insert (the composer then collapses a large one to a `[Pasted …]`
  // placeholder). We enable the mode here because Ink only emits `ESC[?2004h`
  // itself while a `usePaste` hook is active. Guarded for non-TTY (piped stdout
  // in CI). Disabled on exit so we never leave the terminal in paste mode.
  enableBracketedPaste()
  // Enter the alternate screen buffer BEFORE the first paint when the effective
  // layout is fullscreen, so the opening frame draws on the cleared alt buffer
  // instead of flashing on the normal buffer first (the App's own effect also
  // manages this for live `/layout` toggles — the escapes are idempotent). The
  // `finally` below restores the terminal on every exit path as a safety net in
  // case React's unmount cleanup is skipped on a hard signal.
  const fullscreen = resolveLayoutMode(config.layout, readLayoutCapability()) === "fullscreen"
  if (fullscreen) {
    enterAltScreen()
    // Apply the configured mouse model before the first paint. `select` (default)
    // keeps native click-drag selection and disables alternate-scroll; `scroll`
    // captures the wheel. The App's effect also manages this for live `/mouse` /
    // `/layout` toggles; the `finally` below is the hard-exit safety net.
    applyMouseMode(config.mouse ?? DEFAULT_MOUSE_MODE)
  }
  const instance = render(
    <App
      config={config}
      sessionId={sessionId}
      createSession={deps.createSession}
      pushHandoff={deps.pushHandoff}
      trusted={trusted}
      initialHistory={initialHistory}
      altScreenPreEntered={fullscreen}
    />,
    // The App owns Ctrl+C: a single press shows the "press again to exit" hint,
    // a double press exits. Ink's built-in `exitOnCtrlC` (default true) would
    // also fire on the first press, calling `disableRawMode()` + tearing down
    // the stdin readable listener — which silently kills the composer's input
    // (looks like the input box "loses focus" and never recovers). Disable it
    // so the App's handler is the sole owner of Ctrl+C.
    { exitOnCtrlC: false }
  )
  try {
    await instance.waitUntilExit()
  } finally {
    disableBracketedPaste()
    // Restore the terminal's default title (no-op if disabled / non-TTY). The
    // App's unmount cleanup already does this on a clean exit; this is the
    // hard-signal safety net, mirroring the alt-screen/mouse restores below.
    if (config.terminalTitle !== false) resetTerminalTitle()
    // Restore the normal screen buffer (no-op if we never entered or already
    // exited via the App's cleanup). Idempotent at the terminal level. Disable
    // mouse tracking too, so a hard exit never leaves the terminal spewing raw
    // mouse escapes.
    if (fullscreen) {
      resetMouse()
      exitAltScreen()
    }
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
