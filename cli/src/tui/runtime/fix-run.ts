/**
 * Streaming `/fix` runner for the TUI — a bounded test-fix loop.
 *
 * Mirrors `goal-run.ts` / `loop-run.ts`: an App-level effect (where `agent.send`
 * is in scope) that drives fix turns through {@link runDrivenTurns}. The twist is
 * that test execution is deterministic (a child process via the shared `runShell`
 * seam) while the *fixing* is the agent's streamed turns:
 *
 *   1. Run the test command once up front. Green → notice + short-circuit (no
 *      driver, no pill).
 *   2. Red → seed the first fix prompt and hand the loop to `runDrivenTurns`,
 *      whose `advance` re-runs the test after each agent turn: green stops
 *      "done", the round cap stops "error", otherwise it continues with the fresh
 *      failure.
 *
 * CLI is English-only.
 */
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { CLI_FIX_TESTS_PROMPT } from "@/lib/agent/prompts/cli-prompts"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptResolutionContext } from "@/lib/prompts/types"
import { primeCliPromptContext } from "../../agent/prompt-overrides"
import type { RunShellOpts, ShellResult } from "../../agent/run-shell"
import { runShell } from "../../agent/run-shell"
import { runDrivenTurns, type DrivenAdvance } from "./driven-turns"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

/** Cap the failure output fed back to the model — failures cluster at the tail. */
const MAX_OUTPUT_CHARS = 12_000

export interface FixRunDeps {
  send: (prompt: string) => Promise<RunAndCaptureResult | null>
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Config home; primes the Prompt Center overrides the fix prompt resolves. */
  home?: string
  signal: AbortSignal
  testCommand: string
  maxRounds: number
  takeSteer?: () => string | null
  /** Test runner seam (defaults to the shared `runShell`). */
  runTest?: (command: string, opts: RunShellOpts) => Promise<ShellResult>
}

/** Keep the tail of a long test log, marking the truncation. */
export function tailOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  const t = text.trimEnd()
  if (t.length <= max) return t
  return `…(${t.length - max} earlier chars truncated)…\n${t.slice(-max)}`
}

export interface FixFailure {
  command: string
  code: number
  output: string
  round: number
  maxRounds: number
}

/**
 * Build the framed fix instruction from the `developer.cli.fix-tests` slot
 * (ADR-0236). Synchronous: the run primed the override snapshot first.
 */
export function buildFixPrompt(f: FixFailure, context: PromptResolutionContext = {}): string {
  const output = tailOutput(f.output) || "(no output captured)"
  return resolvePrompt(CLI_FIX_TESTS_PROMPT, {
    context,
    values: {
      command: f.command,
      code: String(f.code),
      round: String(f.round),
      maxRounds: String(f.maxRounds),
      output,
    },
  }).text
}

/** Combined stdout+stderr for the failure prompt. */
function combineOutput(res: ShellResult): string {
  return [res.stdout, res.stderr]
    .filter((s) => s && s.trim())
    .join("\n")
    .trim()
}

export async function runFixStreaming(deps: FixRunDeps): Promise<void> {
  const runTest = deps.runTest ?? runShell
  const command = deps.testCommand

  const first = await runTest(command, { cwd: deps.cwd, signal: deps.signal })
  if (deps.signal.aborted) return
  if (first.code === 0) {
    deps.dispatch({ type: "NOTICE", message: `Tests already passing — \`${command}\` exited 0.` })
    return
  }

  const promptContext = await primeCliPromptContext(deps.cwd, deps.home)
  if (deps.signal.aborted) return

  let round = 1
  const advance = async (): Promise<DrivenAdvance> => {
    const res = await runTest(command, { cwd: deps.cwd, signal: deps.signal })
    if (res.code === 0) {
      return {
        kind: "stop",
        status: "done",
        summary: `Tests pass — fixed after ${round} round${round === 1 ? "" : "s"}.`,
      }
    }
    if (round >= deps.maxRounds) {
      return {
        kind: "stop",
        status: "error",
        summary: `Still failing after ${deps.maxRounds} round${deps.maxRounds === 1 ? "" : "s"}.`,
      }
    }
    round += 1
    return {
      kind: "continue",
      prompt: buildFixPrompt(
        {
          command,
          code: res.code,
          output: combineOutput(res),
          round,
          maxRounds: deps.maxRounds,
        },
        promptContext
      ),
    }
  }

  await runDrivenTurns({
    send: deps.send,
    firstPrompt: buildFixPrompt(
      {
        command,
        code: first.code,
        output: combineOutput(first),
        round: 1,
        maxRounds: deps.maxRounds,
      },
      promptContext
    ),
    advance,
    dispatch: deps.dispatch,
    signal: deps.signal,
    label: truncate(command),
    kind: "loop",
    max: deps.maxRounds,
    ...(deps.takeSteer ? { takeSteer: deps.takeSteer } : {}),
  })
}
