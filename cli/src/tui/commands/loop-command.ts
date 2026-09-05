/**
 * `/loop [interval] <prompt> [--n <count>]` — run a prompt as a self-driving
 * loop, reusing the `lib/loop` engine.
 *
 * Two modes, distinguished by a leading interval token:
 *   - `/loop 5m <prompt>`  → **interval**: re-send on a fixed cadence (parsed by
 *                            `lib/loop/interval.parseInterval`).
 *   - `/loop <prompt>`     → **self-paced**: the model ends each reply with a
 *                            JSON trailer the turn-driver reads to decide whether
 *                            to continue and how long to wait.
 *
 * `--n N` / `--n=N` caps the iteration count in either mode. Pure: the handler
 * parses and returns a `loop` {@link CommandEffect}; the App drives the turns
 * (streaming each into the transcript) via `runLoopStreaming`.
 */
import { parseInterval } from "@/lib/loop/interval"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** Upper bound on the `--n` iteration cap (defensive — the lib default is 100). */
export const LOOP_MAX_ITERATIONS = 1000

const clampN = (n: number): number => Math.max(1, Math.min(LOOP_MAX_ITERATIONS, n))

export interface ParsedLoop {
  mode: "self_paced" | "interval"
  prompt: string
  intervalMs?: number
  maxIterations?: number
}

/**
 * Parse `[interval] <prompt> [--n N | --n=N]`. Returns `null` when no prompt
 * remains. A leading interval token (`30s`/`5m`/`2h`/`1d`) selects interval mode.
 */
export function parseLoopArgs(args: string): ParsedLoop | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)

  let mode: ParsedLoop["mode"] = "self_paced"
  let intervalMs: number | undefined
  // A leading interval token switches to interval mode and is consumed.
  const lead = parseInterval(tokens[0])
  if (lead !== null) {
    mode = "interval"
    intervalMs = lead
    tokens.shift()
  }

  const rest: string[] = []
  let maxIterations: number | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const eq = /^--n=(\d+)$/.exec(t)
    if (eq) {
      maxIterations = clampN(Number(eq[1]))
      continue
    }
    if (t === "--n") {
      const next = tokens[i + 1]
      if (next && /^\d+$/.test(next)) {
        maxIterations = clampN(Number(next))
        i++
      }
      continue
    }
    rest.push(t)
  }

  const prompt = rest.join(" ").trim()
  if (!prompt) return null
  return {
    mode,
    prompt,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  }
}

function handle(ctx: CommandContext): CommandEffect {
  const control = ctx.args.trim()
  if (control === "pause" || control === "resume" || control === "stop") {
    return { kind: "loopControl", action: control }
  }
  const parsed = parseLoopArgs(ctx.args)
  if (!parsed) {
    return { kind: "notice", message: "Usage: /loop [interval] <prompt> [--n <count>]" }
  }
  return {
    kind: "loop",
    mode: parsed.mode,
    prompt: parsed.prompt,
    ...(parsed.intervalMs !== undefined ? { intervalMs: parsed.intervalMs } : {}),
    ...(parsed.maxIterations !== undefined ? { maxIterations: parsed.maxIterations } : {}),
  }
}

export const loopCommand: CommandDescriptor = {
  name: "loop",
  description: "run a prompt as a self-paced or interval loop",
  category: "cognia",
  argumentHint: "[interval] <prompt> [--n <count>]",
  handler: handle,
  subcommands: (["pause", "resume", "stop"] as const).map((action) => ({
    name: action,
    description: `${action} the foreground loop`,
    handler: (ctx) =>
      ctx.args.trim()
        ? { kind: "notice", message: `Usage: /loop ${action}` }
        : { kind: "loopControl", action },
  })),
}
