/**
 * `/loop <prompt> [--n <count>]` — repeat a prompt for several chat turns.
 *
 * Pure: the handler parses the args and returns a `loop` {@link CommandEffect};
 * the App drives the turns through the same `agent.send` path the chat uses (so
 * each iteration streams into the transcript) and stops on Esc. The default is 3
 * turns, capped at {@link LOOP_MAX} so a typo can't fork-bomb the session.
 */
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

export const LOOP_DEFAULT = 3
export const LOOP_MAX = 50

const clamp = (n: number): number => Math.max(1, Math.min(LOOP_MAX, n))

/** Parse `<prompt> [--n N | --n=N]` → prompt + iteration count (null if empty). */
export function parseLoopArgs(args: string): { prompt: string; max: number } | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)
  const rest: string[] = []
  let max = LOOP_DEFAULT
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const eq = /^--n=(\d+)$/.exec(t)
    if (eq) {
      max = clamp(Number(eq[1]))
      continue
    }
    if (t === "--n") {
      const next = tokens[i + 1]
      if (next && /^\d+$/.test(next)) {
        max = clamp(Number(next))
        i++
      }
      continue
    }
    rest.push(t)
  }
  const prompt = rest.join(" ").trim()
  if (!prompt) return null
  return { prompt, max }
}

function handle(ctx: CommandContext): CommandEffect {
  const parsed = parseLoopArgs(ctx.args)
  if (!parsed) {
    return { kind: "notice", message: "Usage: /loop <prompt> [--n <count>]" }
  }
  return { kind: "loop", prompt: parsed.prompt, max: parsed.max }
}

export const loopCommand: CommandDescriptor = {
  name: "loop",
  description: "repeat a prompt for several chat turns",
  category: "cognia",
  argumentHint: "<prompt> [--n <count>]",
  handler: handle,
}
