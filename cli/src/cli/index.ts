/**
 * Command dispatcher for `cognia-agent`. `main(argv)` returns an exit code so
 * it unit-tests without touching `process.exit`. The thin executable wrapper
 * lives in `entry.ts`.
 */

import { boolFlag, parseArgv } from "./args"
import { runCommand as defaultRun } from "./run-command"
import { authCommand as defaultAuth } from "./auth-command"
import { configCommand as defaultConfig } from "./config-command"
import { handoffCommand as defaultHandoff, resumeCommand as defaultResume } from "./handoff-cmd"
import { chatCommand as defaultChat } from "./chat"
import { logtoCommand as defaultLogto } from "./logto-command"
import { serveCommand as defaultServe } from "../serve/serve-command"
import { realOutput, type OutputSink } from "./output"
import { VERSION } from "../version"

export { VERSION }

export const HELP = `cognia-agent — standalone Cognia coding agent

Usage:
  cognia-agent chat [--continue | --resume [id]]       interactive terminal agent
                    [--backend builtin|codex|claude-code|<preset>]
                    [--plugin-tools] [--dev-plugins]
  cognia-agent -p "<prompt>"                            headless one-shot (alias of run)
  cognia-agent run "<prompt>" [--model m] [--provider p] [--cwd dir]
                              [--system s] [--allow a,b] [--yes] [--max-turns n]
                              [--output-format text|json|stream-json] [--json]
                              [--timeout ms] [--handoff]
                              [--plugin-tools] [--dev-plugins [--dev-plugins-dir d]]
  cognia-agent handoff <sessionId>          push a session to the desktop app
  cognia-agent resume <id> "<prompt>"       continue a desktop hand-back
  cognia-agent auth <login|status|logout> [--provider p] [--api-key k]
  cognia-agent logto <login|status|logout>          cloud OIDC (Logto) session
                     [--issuer u] [--client-id id] [--resource api] [--scope a,b] [--org id]
  cognia-agent config <get|set|path>
  cognia-agent serve [--server-url u] [--account id] [--home dir]
                     [--flush-debounce ms]           headless brain for cognia-server
                     (COGNIA_SERVER_URL / COGNIA_SERVICE_TOKEN / COGNIA_BRIDGE_URL /
                      COGNIA_LOCAL_ACCOUNT_ID / COGNIA_DATA_DIR via env)

Headless prompt is read from the argument AND piped stdin
  (echo "context" | cognia-agent -p "summarize this").

Flags:
  -p, --print           headless one-shot turn without the 'run' keyword
  -y, --yes             approve all tool requests (non-interactive / CI)
  -c, --continue        chat: resume the most recent session at launch
      --resume [id]     chat: resume a session by id (bare → session picker)
      --backend id      chat: host builtin (default) or an external-agent preset
      --output-format   text (default) | json (one result object) | stream-json (JSONL)
      --json            alias for --output-format stream-json
      --max-turns n     cap the agentic loop for this run
      --plugin-tools    expose in-tree first-party plugin tools to the agent
      --dev-plugins     also load the repo's plugins/<id> as live dev plugins
  -h, --help            show this help
  -v, --version         print the version
`

/** Real subcommands — anything else under `--print` is treated as a prompt. */
const KNOWN_COMMANDS = new Set([
  "run",
  "auth",
  "config",
  "handoff",
  "resume",
  "chat",
  "serve",
  "logto",
])

export interface MainDeps {
  run?: typeof defaultRun
  auth?: typeof defaultAuth
  config?: typeof defaultConfig
  handoff?: typeof defaultHandoff
  resume?: typeof defaultResume
  chat?: typeof defaultChat
  logto?: typeof defaultLogto
  serve?: typeof defaultServe
  out?: OutputSink
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const args = parseArgv(argv)

  if (args.version) {
    out.write(`${VERSION}\n`)
    return 0
  }
  if (args.help) {
    out.write(HELP)
    return 0
  }

  // Headless shorthand: `cognia-agent -p "<prompt>"` (no `run` keyword). The
  // parser shifts the first prompt word into `args.command`, so reconstruct the
  // prompt from command + positionals and hand it to `run`. Only triggers when
  // `--print` is set and the command isn't one of the real subcommands, so
  // `run`/`chat`/… keep their own `-p` handling. A bare `-p` with only piped
  // stdin (no positionals) still works — the prompt resolves to "".
  if (boolFlag(args, "print") && !KNOWN_COMMANDS.has(args.command ?? "")) {
    const promptOverride = [args.command, ...args.positionals].filter(Boolean).join(" ")
    return (deps.run ?? defaultRun)(args, { out, promptOverride })
  }

  if (!args.command) {
    out.error(HELP)
    return 2
  }

  switch (args.command) {
    case "run":
      return (deps.run ?? defaultRun)(args, { out })
    case "auth":
      return (deps.auth ?? defaultAuth)(args, { out })
    case "config":
      return (deps.config ?? defaultConfig)(args, { out })
    case "handoff":
      return (deps.handoff ?? defaultHandoff)(args, { out })
    case "resume":
      return (deps.resume ?? defaultResume)(args, { out })
    case "chat":
      return (deps.chat ?? defaultChat)(args, { out })
    case "logto":
      return (deps.logto ?? defaultLogto)(args, { out })
    case "serve":
      return (deps.serve ?? defaultServe)(args, { out })
    default:
      out.error(`unknown command "${args.command}"\n\n${HELP}`)
      return 2
  }
}
