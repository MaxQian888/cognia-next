import React from "react"
import { render, useWindowSize } from "ink"

import { TuiInputProvider } from "../input/input-router"
import { applyMouseMode, enterAltScreen, exitAltScreen, resetMouse } from "../screen"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"

const interactive = Boolean(
  process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb"
)

if (!interactive) {
  process.stdout.write("LAYOUT scrollback\nEVENT text-delta:hello\n")
  process.exit(0)
}

// Keep the non-TTY fallback dependency-light, but mount the real production App
// for every interactive PTY scenario.
const { App } = await import("../components/App")

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: process.cwd(),
  layout: "fullscreen",
  mascot: { ...DEFAULT_RESOLVED_CONFIG.mascot, enabled: false },
}

const createSession: CreateSession = () => ({
  sessionId: "pty-fixture",
  async send(_prompt, options) {
    options.onEvent?.({ type: "text-delta", delta: "deterministic reply" })
    return {
      text: "deterministic reply",
      messageId: "pty-message",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  },
  async close() {},
})

function GeometryProbe(): null {
  const { columns, rows } = useWindowSize()
  const first = React.useRef(true)
  React.useEffect(() => {
    process.stdout.write(`${first.current ? "READY" : "RESIZE"} ${columns}x${rows}\n`)
    first.current = false
  }, [columns, rows])
  return null
}

enterAltScreen()
applyMouseMode("scroll")
const instance = render(
  <TuiInputProvider>
    <App
      config={config}
      sessionId="pty-fixture"
      createSession={createSession}
      trusted
      altScreenPreEntered
      layoutCapability={{ stdoutIsTTY: true, stdinIsTTY: true, term: process.env.TERM }}
      home="/tmp/cognia-tui-fixture"
      persistHistory={() => {}}
      persistDb={() => {}}
      resolveMeta={async (_provider, model) => ({
        modelId: model ?? "fixture-model",
        contextWindow: 200_000,
      })}
    />
    <GeometryProbe />
  </TuiInputProvider>,
  { exitOnCtrlC: false, incrementalRendering: false }
)

let cleaning = false
const cleanup = () => {
  if (cleaning) return
  cleaning = true
  instance.unmount()
  resetMouse()
  exitAltScreen()
  process.stdout.write("CLEANUP\n")
  process.exit(0)
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)
setTimeout(cleanup, 2_000).unref()
