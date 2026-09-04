/**
 * Drive a whole conversation through the production TUI in a real terminal.
 *
 * The existing `runPtyScenario` plays one hard-coded exchange. This runs an
 * arbitrary {@link ConversationScenario}: the shipped `App`, mounted from the
 * same esbuild bundle the CLI ships, in a real PTY, with the screen
 * reconstructed cell by cell so an assertion is about what the user sees rather
 * than about every byte ever written.
 *
 * Every wait is on an observable state, never on a fixed delay. Waiting a fixed
 * number of milliseconds is how a suite ends up asserting a race, and it is the
 * reason the old matrix could pass while the reply had not rendered.
 *
 * Test-only. Nothing here is bundled into the CLI.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as pty from "node-pty"

import { fixtureArgs } from "./node-pty-harness"
import { TerminalScreen } from "./terminal-screen"
import { emptyScenarioRecord, type ConversationScenario, type ScenarioRecord } from "./scenario"
import type { ResolvedConfig } from "../../config/schema"

const ESC = "\u001b"

export interface ConversationGeometry {
  columns: number
  rows: number
}

export interface ConversationOptions {
  scenario: ConversationScenario & { config?: Partial<ResolvedConfig> }
  geometry?: ConversationGeometry
  /** Overall budget for the whole conversation. */
  timeoutMs?: number
  /** Extra environment for the fixture process. */
  env?: Record<string, string>
  /** Working directory. Defaults to a fresh temporary directory. */
  cwd?: string
  /** CLI home. Defaults to a fresh directory, so runs never share history. */
  home?: string
}

export interface WaitOptions {
  /** Budget for this wait alone. Defaults to the run's remaining time. */
  timeoutMs?: number
  /** What the caller was waiting for, quoted back in the failure. */
  describe?: string
}

/** Keys the driver can press by name, so a test never spells an escape itself. */
export const KEYS = {
  enter: "\r",
  escape: ESC,
  tab: "\t",
  shiftTab: `${ESC}[Z`,
  backspace: "\u007f",
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  pageUp: `${ESC}[5~`,
  pageDown: `${ESC}[6~`,
  ctrlC: "\u0003",
  ctrlD: "\u0004",
  ctrlO: "\u000f",
  ctrlT: "\u0014",
} as const

export type KeyName = keyof typeof KEYS

export interface TerminalModes {
  altScreen: boolean
  cursorVisible: boolean
  mouse: string[]
}

export interface ConversationSession {
  /** The reconstructed screen, one string per visible row. */
  rows(): string[]
  /** The reconstructed screen as text. */
  screen(): string
  /** The screen with whitespace collapsed, for a phrase a narrow terminal wrapped. */
  flat(): string
  /** Terminal modes the app has left switched on. */
  modes(): TerminalModes
  /** Type text one keystroke at a time, the way a person does. */
  type(text: string): Promise<void>
  /** Press one named key. */
  press(key: KeyName): Promise<void>
  /** Send raw bytes, for a sequence the key table does not name. */
  raw(bytes: string): Promise<void>
  /** Type a message and send it. */
  send(text: string): Promise<void>
  /** Wait until the screen satisfies `predicate`. */
  waitFor(predicate: (screen: string) => boolean, options?: WaitOptions): Promise<void>
  /** Wait until the screen contains `needle`, whitespace-insensitively. */
  waitForText(needle: string, options?: WaitOptions): Promise<void>
  /** Wait until the screen no longer contains `needle`. */
  waitForNoText(needle: string, options?: WaitOptions): Promise<void>
  /** Wait for a lifecycle marker the fixture emitted out of band. */
  waitForMarker(marker: string, options?: WaitOptions): Promise<void>
  /** Wait until the nth turn (1-based) has finished, however it finished. */
  waitForTurnEnd(turn: number, options?: WaitOptions): Promise<void>
  /** Resize the terminal and wait for the app to acknowledge the new size. */
  resize(columns: number, rows: number): Promise<void>
  /** Everything written to the terminal, for a diagnostic. */
  transcript(): string
}

export interface ConversationResult {
  /** The last screen before the app was asked to quit. */
  finalScreen: string
  /** What the scripted agent was told. */
  record: ScenarioRecord
  /** Exit code of the fixture process. */
  exitCode: number
  /**
   * Terminal modes AFTER teardown. This is the state the user's shell inherits,
   * so a session that exits still in the alternate screen, with the cursor
   * hidden, or with the mouse captured, has left the terminal unusable.
   */
  modesAtExit: TerminalModes
  transcript: string
}

/** A wait that ran out of time, reported with everything needed to diagnose it. */
export class ConversationTimeout extends Error {
  constructor(
    what: string,
    readonly screen: string,
    readonly actions: string[],
    readonly transcript: string,
    readonly geometry: ConversationGeometry
  ) {
    super(
      [
        `Timed out waiting for ${what}.`,
        `Terminal: ${geometry.columns}x${geometry.rows}`,
        `Actions so far: ${actions.length > 0 ? actions.join(" -> ") : "(none)"}`,
        "Screen:",
        screen === "" ? "(blank)" : screen,
        "Raw tail:",
        transcript.slice(-2000),
      ].join("\n")
    )
    this.name = "ConversationTimeout"
  }
}

const DEFAULT_GEOMETRY: ConversationGeometry = { columns: 100, rows: 30 }

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

/** Whitespace-insensitive comparison, so a phrase the terminal wrapped across
 * two rows still reads as one. */
function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

/**
 * Run one conversation.
 *
 * `body` gets a live session. When it returns, the app is asked to quit and the
 * result carries the final screen, the agent's record, and the terminal modes
 * at exit.
 */
export async function runConversation(
  options: ConversationOptions,
  body: (session: ConversationSession) => Promise<void>
): Promise<ConversationResult> {
  const geometry = options.geometry ?? DEFAULT_GEOMETRY
  const budget = options.timeoutMs ?? 30_000
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-conversation-"))
  const scenarioPath = path.join(workspace, "scenario.json")
  const recordPath = path.join(workspace, "record.json")
  fs.writeFileSync(scenarioPath, JSON.stringify(options.scenario))

  const screen = new TerminalScreen(geometry)
  const terminal = pty.spawn(process.execPath, fixtureArgs(), {
    name: "xterm-256color",
    cols: geometry.columns,
    rows: geometry.rows,
    cwd: options.cwd ?? workspace,
    env: {
      ...stringEnv(process.env),
      ...(options.env ?? {}),
      TERM: "xterm-256color",
      COGNIA_PTY_SCENARIO: scenarioPath,
      COGNIA_PTY_RECORD: recordPath,
      // A fresh home per run: a scenario must never read another one's history.
      COGNIA_HOME: options.home ?? path.join(workspace, "home"),
    },
  })

  let transcript = ""
  let turnsStarted = 0
  let current = geometry
  const actions: string[] = []
  const watchers = new Set<() => void>()
  let exitCode = -1
  const exited = new Promise<void>((resolve) => {
    terminal.onExit(({ exitCode: code }) => {
      exitCode = code
      resolve()
    })
  })
  terminal.onData((chunk) => {
    transcript += chunk
    screen.write(chunk)
    for (const watcher of [...watchers]) watcher()
  })

  const deadline = Date.now() + budget
  const remaining = () => Math.max(0, deadline - Date.now())

  /** The fixture's out-of-band markers, read off the raw stream. */
  const markerRe = /\u001b\]777;cognia;([^\u0007]*)\u0007/gu
  const markers = () => [...transcript.matchAll(markerRe)].map((m) => m[1])

  const waitOn = (
    check: () => boolean,
    waitOptions: WaitOptions | undefined,
    fallbackDescription: string
  ) =>
    new Promise<void>((resolve, reject) => {
      if (check()) {
        resolve()
        return
      }
      const limit = Math.max(1, Math.min(waitOptions?.timeoutMs ?? remaining(), remaining()))
      const watcher = () => {
        if (!check()) return
        clearTimeout(timer)
        watchers.delete(watcher)
        resolve()
      }
      const timer = setTimeout(() => {
        watchers.delete(watcher)
        reject(
          new ConversationTimeout(
            waitOptions?.describe ?? fallbackDescription,
            screen.text(),
            actions,
            transcript,
            current
          )
        )
      }, limit)
      watchers.add(watcher)
    })

  const waitFor: ConversationSession["waitFor"] = (predicate, waitOptions) =>
    waitOn(() => predicate(screen.text()), waitOptions, "a screen condition")

  const waitForMarker = (mark: string, waitOptions?: WaitOptions) =>
    waitOn(() => markers().includes(mark), waitOptions, `marker ${JSON.stringify(mark)}`)

  const modes = (): TerminalModes => ({
    altScreen: screen.altScreen,
    cursorVisible: screen.cursorVisible,
    mouse: [...screen.mouseModes].sort(),
  })

  const session: ConversationSession = {
    rows: () => screen.lines(),
    screen: () => screen.text(),
    flat: () => screen.flatText(),
    modes,
    transcript: () => transcript,
    async type(text) {
      actions.push(`type(${JSON.stringify(text)})`)
      // One keystroke at a time, each confirmed on screen before the next.
      //
      // Writing the whole string in one go is both faster and wrong: the keymap
      // reads a multi-character chunk as a PASTE, which is a different code
      // path from typing (no palette opens, a newline inside it becomes text
      // rather than a send), and no terminal user ever produces one by typing.
      // The per-character confirmation is also what proves the child has READ
      // the input, so the Enter that follows cannot arrive in the same read.
      let typed = ""
      for (const ch of [...text]) {
        terminal.write(ch)
        typed += ch
        const shown = flatten(typed)
        if (shown === "") continue
        await waitFor((s) => flatten(s).includes(shown), {
          describe: `the composer to show ${JSON.stringify(typed)}`,
        })
      }
    },
    async press(key) {
      actions.push(`press(${key})`)
      terminal.write(KEYS[key])
    },
    async raw(bytes) {
      actions.push(`raw(${JSON.stringify(bytes)})`)
      terminal.write(bytes)
    },
    async send(text) {
      await session.type(text)
      const turn = turnsStarted + 1
      await session.press("enter")
      // Wait for the agent to actually receive the turn. Without this the next
      // keystroke can land in the same read as the Enter, and the keymap treats
      // a multi-character chunk as a paste, so the newline becomes text and the
      // message is never sent (`input/keymap.ts`).
      await waitForMarker(`TURN-START ${turn}`, {
        describe: `turn ${turn} to start`,
      })
      turnsStarted = turn
    },
    waitFor,
    waitForMarker,
    waitForTurnEnd: (turn, waitOptions) =>
      waitForMarker(`TURN-END ${turn}`, {
        describe: `turn ${turn} to finish`,
        ...waitOptions,
      }),
    async waitForText(needle, waitOptions) {
      await waitFor((s) => flatten(s).includes(flatten(needle)), {
        describe: `text ${JSON.stringify(needle)}`,
        ...waitOptions,
      })
    },
    async waitForNoText(needle, waitOptions) {
      await waitFor((s) => !flatten(s).includes(flatten(needle)), {
        describe: `text ${JSON.stringify(needle)} to disappear`,
        ...waitOptions,
      })
    },
    async resize(columns, rows) {
      actions.push(`resize(${columns}x${rows})`)
      screen.resize(columns, rows)
      current = { columns, rows }
      terminal.resize(columns, rows)
      await waitForMarker(`RESIZE ${columns}x${rows}`, {
        describe: `the app to acknowledge ${columns}x${rows}`,
      })
    },
  }

  let failure: unknown
  try {
    await waitForMarker(`READY ${geometry.columns}x${geometry.rows}`, {
      describe: "the app's first frame",
    })
    await body(session)
  } catch (error) {
    failure = error
  }

  const finalScreen = screen.text()
  terminal.kill("SIGINT")
  let quitTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      quitTimer = setTimeout(resolve, 5_000)
    }),
  ])
  if (quitTimer) clearTimeout(quitTimer)
  if (exitCode === -1) terminal.kill("SIGKILL")

  let record = emptyScenarioRecord()
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as ScenarioRecord
  } catch {
    // Left empty. A test that needs the record asserts on it and will say so.
  }
  fs.rmSync(workspace, { recursive: true, force: true })
  if (failure) throw failure
  return { finalScreen, record, exitCode, modesAtExit: modes(), transcript }
}
