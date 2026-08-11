/**
 * Workflow executor for `action.terminal.script` — run a script *file*
 * (.sh / .ps1 / .py / .js / …) under the right interpreter.
 *
 * The extension → interpreter mapping is owned by
 * `lib/terminal/script-runner.ts:detectScriptType` (ADR-0039) — the same
 * pure module behind the dock's "run this file" affordance — so workflow
 * runs and interactive runs can never disagree about what executes a
 * `.py`. An explicit `interpreter` param bypasses detection.
 *
 * The resolved invocation is composed into one command line
 * (`<interpreter> [interpreterArgs] <scriptPath> [args]`, whitespace-
 * containing tokens double-quoted) and routed through the exact gates the
 * other terminal nodes use:
 *
 *   * dock (default)   — `runTerminalDockAction` spawn: visible tab,
 *     consent via the agent-trust broker, OSC 633 exit-code wait.
 *   * unattended: true — `runHeadlessExec` policy layer: master switch +
 *     classifyCommand verdict + ask-policy, audited.
 *
 * Inputs (ctx.params):
 *   scriptPath:  string             — required, path to the script file
 *   interpreter: string             — optional explicit override
 *   args:        string[]           — optional args passed to the script
 *   cwd:         string             — optional working directory
 *   projectId:   string             — optional (dock tab routing)
 *   timeoutSec:  number             — optional, clamped to [5, 600]
 *   onFailure:   "throw"|"branch"   — non-zero exit: throw (default) or branch
 *   unattended:  boolean            — headless policy layer instead of the dock
 *   onAskVerdict: "fail"|"consent"|"run" — unattended ask-policy override
 *
 * Output: { exitCode, output, command, scriptPath, durationMs?, timedOut? }
 */

import { registerNodeExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

interface ScriptParams {
  scriptPath?: string
  interpreter?: string
  args?: string[]
  cwd?: string
  projectId?: string
  timeoutSec?: number
  onFailure?: "throw" | "branch"
  unattended?: boolean
  onAskVerdict?: "fail" | "consent" | "run"
}

/** Double-quote a token when it contains whitespace (paths with spaces). */
function quoteArg(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token
}

/**
 * Resolve interpreter + flags and compose the final command line. Exported
 * for tests — pure, no IO.
 */
export async function composeScriptCommand(params: ScriptParams): Promise<string> {
  const scriptPath = (params.scriptPath ?? "").trim()
  let interpreter: string
  let interpreterArgs: string[]
  const override = (params.interpreter ?? "").trim()
  if (override.length > 0) {
    interpreter = override
    interpreterArgs = []
  } else {
    const { detectScriptType } = await import("@/lib/terminal/script-runner")
    const type = detectScriptType(scriptPath)
    if (!type) {
      throw nonRetryable(
        `action.terminal.script: cannot determine an interpreter for "${scriptPath}" — set 'interpreter' explicitly`
      )
    }
    interpreter = type.interpreter
    interpreterArgs = type.interpreterArgs
  }
  const tokens = [
    interpreter,
    ...interpreterArgs,
    scriptPath,
    ...(Array.isArray(params.args) ? params.args : []),
  ]
  return tokens.map(quoteArg).join(" ")
}

registerNodeExecutor({
  kind: "action.terminal.script",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as ScriptParams
    const scriptPath = (params.scriptPath ?? "").trim()
    if (!scriptPath) {
      throw nonRetryable("action.terminal.script requires a non-empty 'scriptPath'")
    }
    const composed = await composeScriptCommand(params)
    const timeoutSec = clampTimeout(params.timeoutSec)

    let exitCode: number | null
    let output: string
    let durationMs: number | undefined
    let timedOut = false

    if (params.unattended === true) {
      const { runHeadlessExec } = await import("@/lib/terminal/headless-exec")
      const result = await runHeadlessExec({
        command: composed,
        cwd: params.cwd,
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
        onAskVerdict: params.onAskVerdict,
        chatSessionId: ctx.runId,
        runId: ctx.runId,
        source: "workflow",
      })
      if (!result.ok) {
        throw nonRetryable(`action.terminal.script: ${result.reason}`)
      }
      exitCode = result.exitCode
      output = result.output
      durationMs = result.durationMs
      timedOut = result.timedOut
    } else {
      const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
      const result = await runTerminalDockAction({
        chatSessionId: ctx.runId,
        action: "spawn",
        args: {
          command: composed,
          cwd: params.cwd,
          projectId: params.projectId,
          timeoutSec,
        },
      })
      if (!result.ok) {
        throw nonRetryable(`action.terminal.script: ${result.reason}`)
      }
      if ("records" in result) {
        throw nonRetryable("action.terminal.script: unexpected dock result shape")
      }
      exitCode = result.exitCode ?? null
      output = result.output ?? ""
    }

    const success = !timedOut && exitCode === 0
    const decision = success ? "success" : "failure"
    if (!success && (params.onFailure ?? "throw") === "throw") {
      throw nonRetryable(
        timedOut
          ? "action.terminal.script: script timed out"
          : `action.terminal.script: script exited with code ${exitCode ?? "null"}`
      )
    }
    return {
      output: { exitCode, output, command: composed, scriptPath, durationMs, timedOut },
      decision,
      logs: [
        {
          level: success ? ("info" as const) : ("warn" as const),
          message: success
            ? `script succeeded (exit ${exitCode})`
            : timedOut
              ? "script timed out"
              : `script failed (exit ${exitCode ?? "null"})`,
        },
      ],
    }
  },
})

function clampTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value < 5) return 5
  if (value > 600) return 600
  return Math.floor(value)
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}
