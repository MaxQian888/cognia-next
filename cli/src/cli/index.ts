/**
 * Command dispatcher for `cognia-agent`. `main(argv)` returns an exit code so
 * it unit-tests without touching `process.exit`. The thin executable wrapper
 * lives in `entry.ts`.
 */

import { parseArgv } from "./args"
import { runCommand as defaultRun } from "./run-command"
import { authCommand as defaultAuth } from "./auth-command"
import { configCommand as defaultConfig } from "./config-command"
import { handoffCommand as defaultHandoff, resumeCommand as defaultResume } from "./handoff-cmd"
import { chatCommand as defaultChat } from "./chat"
import { realOutput, type OutputSink } from "./output"
import { VERSION } from "../version"

export { VERSION }

export const HELP = `cognia-agent — standalone Cognia coding agent

Usage:
  cognia-agent chat [--plugin-tools]        interactive terminal agent
                                            (--plugin-tools enables in-tree plugin tools)
  cognia-agent run "<prompt>" [--model m] [--provider p] [--cwd dir]
                              [--system s] [--allow a,b] [--yes] [--json]
                              [--timeout ms] [--handoff]
  cognia-agent handoff <sessionId>          push a session to the desktop app
  cognia-agent resume <id> "<prompt>"       continue a desktop hand-back
  cognia-agent auth <login|status|logout> [--provider p] [--api-key k]
  cognia-agent config <get|set|path>

Flags:
  -y, --yes      approve all tool requests (non-interactive / CI)
      --json     emit JSONL stream events + a final result line
  -h, --help     show this help
  -v, --version  print the version
`

export interface MainDeps {
  run?: typeof defaultRun
  auth?: typeof defaultAuth
  config?: typeof defaultConfig
  handoff?: typeof defaultHandoff
  resume?: typeof defaultResume
  chat?: typeof defaultChat
  out?: OutputSink
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const args = parseArgv(argv)

  if (args.version) {
    out.write(`${VERSION}\n`)
    return 0
  }
  if (args.help || !args.command) {
    if (args.help) {
      out.write(HELP)
      return 0
    }
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
    default:
      out.error(`unknown command "${args.command}"\n\n${HELP}`)
      return 2
  }
}
