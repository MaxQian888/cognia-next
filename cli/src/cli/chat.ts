/**
 * `cognia-agent chat` — interactive terminal agent.
 *
 * A persistent multi-turn REPL over {@link createAgentSession}: each line is a
 * turn that reuses the same sidecar session (context accumulates), assistant
 * text streams to stdout, tool approvals prompt inline, and slash commands
 * (/exit /clear /handoff /help) drive the session. The loop's collaborators
 * (line reader, confirm, session factory) are injected so it unit-tests with
 * scripted input — the real readline wiring stays a thin default.
 */

import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import { loadConfig as defaultLoadConfig } from "../config/load"
import { createAgentSession, type AgentSession } from "../agent/session-runner"
import { createExternalAgentSession } from "../agent/external-agent-session"
import type { ResolvedConfig } from "../config/schema"
import { createPermissionGate } from "../agent/permission-gate"
import { maybePushHandoff as defaultPushHandoff } from "./handoff-cmd"
import { bypassRequested, runFlagsToOverrides } from "./run-command"
import { boolFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/**
 * Map the session launch flags to the slash command the TUI runs on mount:
 * `--continue` / `-c` → `/continue` (most recent session), `--resume <id>` →
 * `/resume <id>`, bare `--resume` → `/resume` (session picker). Mirrors
 * `claude --continue` / `claude --resume`. Pure + exported for tests.
 */
export function launchCommandFromFlags(args: ParsedArgs): string | undefined {
  if (boolFlag(args, "continue")) return "/continue"
  const resume = args.flags["resume"]
  if (typeof resume === "string") return `/resume ${resume}`
  if (resume === true) return "/resume"
  return undefined
}

/** What a typed line resolves to. */
export type ChatAction =
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "handoff" }
  | { kind: "help" }
  | { kind: "unknown"; command: string }
  | { kind: "send"; text: string }
  | { kind: "noop" }

/** Pure interpretation of one input line. Exported for tests. */
export function interpretLine(line: string): ChatAction {
  const trimmed = line.trim()
  if (!trimmed) return { kind: "noop" }
  if (!trimmed.startsWith("/")) return { kind: "send", text: trimmed }
  const cmd = trimmed.slice(1).split(/\s+/)[0].toLowerCase()
  switch (cmd) {
    case "exit":
    case "quit":
      return { kind: "exit" }
    case "clear":
    case "new":
      return { kind: "clear" }
    case "handoff":
      return { kind: "handoff" }
    case "help":
      return { kind: "help" }
    default:
      return { kind: "unknown", command: cmd }
  }
}

const CHAT_HELP = `Commands:
  /handoff   push this session to the desktop app
  /clear     start a fresh session
  /help      show this help
  /exit      quit
`

export interface ChatDeps {
  loadConfig?: (
    flags?: Parameters<typeof defaultLoadConfig>[0]
  ) => ReturnType<typeof defaultLoadConfig>
  createSession?: typeof createAgentSession
  externalCreateSession?: typeof createExternalAgentSession
  pushHandoff?: typeof defaultPushHandoff
  out?: OutputSink
  /** Read one input line; resolves null on EOF (Ctrl-D). */
  readLine?: (promptStr: string) => Promise<string | null>
  /** Interactive yes/no for tool approvals. */
  confirm?: (question: string) => Promise<boolean>
  /** Whether the terminal is interactive (real TTY). Injected for tests. */
  isTty?: () => boolean
  /** Mount the rich Ink TUI. Injected for tests; defaults to a lazy import. */
  renderTui?: (deps: {
    config: ReturnType<typeof defaultLoadConfig>
    createSession: typeof createAgentSession
    createExternalSession: typeof createExternalAgentSession
    pushHandoff: (sessionId: string) => void | Promise<void>
    initialCommand?: string
    sessionOnlyPermissionMode?: ResolvedConfig["permissionMode"]
  }) => Promise<number>
}

/** Select the built-in or external session implementation from resolved CLI configuration. */
export function selectSessionFactory(
  config: ResolvedConfig,
  builtin: typeof createAgentSession,
  external: typeof createExternalAgentSession
): typeof createAgentSession {
  return config.agentBackend && config.agentBackend !== "builtin" ? external : builtin
}

export async function chatCommand(args: ParsedArgs, deps: ChatDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const builtinCreateSession = deps.createSession ?? createAgentSession
  const externalCreateSession = deps.externalCreateSession ?? createExternalAgentSession
  const pushHandoff = deps.pushHandoff ?? defaultPushHandoff

  let config: ReturnType<typeof defaultLoadConfig>
  try {
    config = loadConfig(runFlagsToOverrides(args))
  } catch (err) {
    out.error(`config error: ${(err as Error).message}`)
    return 2
  }
  const createSession = selectSessionFactory(config, builtinCreateSession, externalCreateSession)

  // Interactive terminal → the rich Ink TUI. A non-TTY (piped stdin / CI) or a
  // test injecting `readLine` falls through to the readline REPL below. The TUI
  // module is imported lazily so `--help`, `run`, and the readline path never
  // pull Ink into the bundle's eager graph.
  const isTty = deps.isTty ?? (() => Boolean(stdout.isTTY && stdin.isTTY))
  const initialCommand = launchCommandFromFlags(args)
  if (isTty() && !deps.readLine) {
    const renderTui = deps.renderTui ?? (await import("../tui/mount")).renderTui
    // The TUI picks the backend itself — `/backend` can switch it mid-session —
    // so it gets BOTH factories rather than the one chosen here. The readline
    // fallback below has no such control and keeps the launch-time choice.
    return renderTui({
      config,
      createSession: builtinCreateSession,
      createExternalSession: externalCreateSession,
      pushHandoff: (sessionId: string) => {
        void pushHandoff(sessionId, undefined, { out })
      },
      initialCommand,
      ...(bypassRequested(args) ? { sessionOnlyPermissionMode: "bypassPermissions" } : {}),
    })
  }
  // The readline fallback has no session store — resuming needs the TUI.
  if (initialCommand) {
    out.error("--continue/--resume need an interactive terminal (TTY); starting fresh.")
  }

  // Default IO (real terminal). Tests inject readLine + confirm instead.
  let rl: readline.Interface | undefined
  const readLine =
    deps.readLine ??
    (async (promptStr: string) => {
      rl ??= readline.createInterface({ input: stdin, output: stdout })
      try {
        return await rl.question(promptStr)
      } catch {
        return null // Ctrl-D / closed
      }
    })
  const confirm =
    deps.confirm ??
    (async (question: string) => {
      const ans = (await readLine(`${question} (y/N) `)) ?? ""
      return /^y(es)?$/i.test(ans.trim())
    })

  out.write(`cognia-agent — interactive (provider: ${config.provider}). /help for commands.\n`)

  let session: AgentSession = createSession({ config })
  const gate = createPermissionGate({ prompt: (req) => confirm(`Allow tool "${req.toolName}"?`) })

  try {
    for (;;) {
      const line = await readLine("› ")
      if (line === null) break // EOF
      const action = interpretLine(line)
      if (action.kind === "noop") continue
      if (action.kind === "exit") break
      if (action.kind === "help") {
        out.write(CHAT_HELP)
        continue
      }
      if (action.kind === "unknown") {
        out.error(`unknown command /${action.command} — /help for the list`)
        continue
      }
      if (action.kind === "clear") {
        await session.close()
        session = createSession({ config })
        out.write("Started a fresh session.\n")
        continue
      }
      if (action.kind === "handoff") {
        await pushHandoff(session.sessionId, undefined, { out })
        continue
      }
      // send
      try {
        let streamed = false
        const result = await session.send(action.text, {
          gate,
          onEvent: (event) => {
            if (event.type === "text-delta" && event.delta) {
              out.write(event.delta)
              streamed = true
            }
          },
        })
        if (!streamed) out.write(result.text)
        out.write("\n")
      } catch (err) {
        out.error(`turn failed: ${(err as Error).message}`)
      }
    }
    return 0
  } finally {
    await session.close()
    rl?.close()
  }
}
