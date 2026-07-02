/**
 * `/fix [test command] [--rounds N]` — a bounded test-fix loop.
 *
 * Runs a test command; if it fails, feeds the failure to the agent to fix, then
 * re-runs — up to N rounds or until green. Pure handler: it parses and returns a
 * `fixRun` {@link CommandEffect}; the App drives the loop (streaming each fix turn
 * into the transcript) via `runFixStreaming`, reusing the same `runDrivenTurns`
 * pump behind `/goal` and `/loop`.
 *
 * CLI is English-only.
 */
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

export const FIX_DEFAULT_COMMAND = "pnpm test"
export const FIX_DEFAULT_ROUNDS = 4
export const FIX_MAX_ROUNDS = 20

const clampRounds = (n: number): number => Math.max(1, Math.min(FIX_MAX_ROUNDS, n))

export interface ParsedFix {
  testCommand: string
  maxRounds: number
}

/**
 * Parse `[test command] [--rounds N | --n N]`. `--rounds`/`--n` (and their `=`
 * forms) set the round cap; everything else is the test command, defaulting to
 * `pnpm test`.
 */
export function parseFixArgs(args: string): ParsedFix {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let maxRounds = FIX_DEFAULT_ROUNDS
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const eq = /^--(?:rounds|n)=(\d+)$/.exec(t)
    if (eq) {
      maxRounds = clampRounds(Number(eq[1]))
      continue
    }
    if (t === "--rounds" || t === "--n") {
      const next = tokens[i + 1]
      if (next && /^\d+$/.test(next)) {
        maxRounds = clampRounds(Number(next))
        i++
      }
      continue
    }
    rest.push(t)
  }
  const testCommand = rest.join(" ").trim() || FIX_DEFAULT_COMMAND
  return { testCommand, maxRounds }
}

function handle(ctx: CommandContext): CommandEffect {
  const { testCommand, maxRounds } = parseFixArgs(ctx.args)
  return { kind: "fixRun", testCommand, maxRounds }
}

export const fixCommand: CommandDescriptor = {
  name: "fix",
  description: "run tests and let the agent fix failures until they pass (bounded)",
  category: "cognia",
  argumentHint: "[test command] [--rounds N]",
  handler: handle,
}
