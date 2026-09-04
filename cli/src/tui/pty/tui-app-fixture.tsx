import fs from "node:fs"
import React from "react"
import { render, useWindowSize } from "ink"

import { TuiInputProvider } from "../input/input-router"
import { applyMouseMode, enterAltScreen, exitAltScreen, resetMouse } from "../screen"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import { emptyScenarioRecord, scenarioCreateSession, type ConversationScenario } from "./scenario"

/** The scenario file the driver wrote, when this run is a scripted conversation. */
const SCENARIO_ENV = "COGNIA_PTY_SCENARIO"
/** Where the record of what the agent was told is written on exit. */
const RECORD_ENV = "COGNIA_PTY_RECORD"

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

interface FixtureScenario extends ConversationScenario {
  /** Config overrides applied on top of the fixture's defaults. */
  config?: Partial<ResolvedConfig>
}

const scenarioPath = process.env[SCENARIO_ENV]
const scenario: FixtureScenario = scenarioPath
  ? (JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as FixtureScenario)
  : {}

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: process.cwd(),
  layout: "fullscreen",
  mascot: { ...DEFAULT_RESOLVED_CONFIG.mascot, enabled: false },
  ...(scenario.config ?? {}),
}

/**
 * Announce a lifecycle moment to the driver without putting it on screen.
 *
 * A plain line printed into a full-screen frame lands wherever the cursor
 * happens to be, corrupting the row it hits and wrapping the marker itself
 * across two rows. An OSC sequence rides the same channel, is dropped by any
 * terminal that does not know it, and is dropped by the screen reconstructor,
 * so the driver can read it while the screen stays exactly what the user sees.
 */
const marker = (text: string) => {
  if (scenarioPath) process.stdout.write(`\u001b]777;cognia;${text}\u0007`)
  // Without a scenario this is the legacy matrix fixture, whose harness reads
  // these markers as plain lines out of the byte stream.
  else process.stdout.write(`${text}\n`)
}

const record = emptyScenarioRecord()
const scripted = scenarioCreateSession(scenario, record)

/**
 * The scripted session, announcing each turn's start and end.
 *
 * A driver that only reads the screen cannot tell "my Enter was accepted" from
 * "my Enter arrived in the same read as the next keystroke and became text".
 * Without a signal for it, a test has to guess how long a submit takes, which
 * is the class of guess this harness exists to remove.
 */
// Counted across the whole run, not per session. A recoverable failure makes
// the app rebuild its agent session, and a per-session counter restarted at one
// there, so a driver waiting for "turn 2" waited forever on a run that had
// already taken its second turn.
let turnsTaken = 0

const createSession: CreateSession = (params) => {
  const session = scripted(params)
  return {
    ...session,
    async send(prompt, options) {
      turnsTaken += 1
      const index = turnsTaken
      marker(`TURN-START ${index}`)
      try {
        return await session.send(prompt, options)
      } finally {
        marker(`TURN-END ${index}`)
      }
    },
  }
}

function GeometryProbe(): null {
  const { columns, rows } = useWindowSize()
  const first = React.useRef(true)
  React.useEffect(() => {
    marker(`${first.current ? "READY" : "RESIZE"} ${columns}x${rows}`)
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
      home={process.env.COGNIA_HOME ?? "/tmp/cognia-tui-fixture"}
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
  // What the scripted agent was told. The screen cannot show a decision that
  // was sent back over the wire, and a test that only reads the screen cannot
  // tell "the user pressed Deny" from "the prompt closed".
  const recordPath = process.env[RECORD_ENV]
  if (recordPath) {
    try {
      fs.writeFileSync(recordPath, JSON.stringify(record))
    } catch {
      // The driver reports a missing record as a failure of its own.
    }
  }
  marker("CLEANUP")
  process.exit(0)
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)
// No fallback auto-exit. A fixture that quit on a timer turned "the app hung"
// into "the test passed and the process happened to be gone", and every driver
// already bounds its own run.
