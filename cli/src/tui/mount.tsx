/**
 * Mounts the Ink TUI for `cognia-agent chat`. The ink `render` is injectable so
 * the wiring is unit-testable without a real terminal.
 */
import React from "react"
import { render as inkRender } from "ink"

import { App } from "./components/App"
import { mintSessionId } from "../agent/run"
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
  const instance = render(
    <App
      config={deps.config}
      sessionId={sessionId}
      createSession={deps.createSession}
      pushHandoff={deps.pushHandoff}
    />
  )
  await instance.waitUntilExit()
  return 0
}
