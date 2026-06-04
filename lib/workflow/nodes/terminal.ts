/**
 * Workflow executor for `action.system.terminal`.
 *
 * Wave 3 — surfaces the integrated terminal dock as a workflow node.
 * Reuses `lib/terminal/dock-tool-handler.ts:runTerminalDockAction` so
 * the consent gate (`requestAgentTrust`), tab routing, and OSC 633
 * command_end wait line up with the chat affordance + the agent's
 * MCP terminal_dock_* tool.
 *
 * Inputs (ctx.params):
 *   command:      string            — required, the command to run
 *   args:         string[]          — optional extra argv (joined onto command for display)
 *   cwd:          string            — optional working directory
 *   shell:        string            — optional override; defaults to the user setting
 *   projectId:    string            — optional, used when spawning a fresh tab
 *   tabId:        string            — optional; when set runs in this tab, else spawns
 *   timeoutSec:   number            — optional, defaults to settings.terminal.runInDockTimeoutSec
 *   onFailure:    "throw"|"branch"  — when exitCode != 0, throw (default) or route to "failure" port
 *
 * Output:
 *   { exitCode, output, sessionId, durationMs }
 *
 * Decision routing:
 *   * exitCode === 0  → emits decision "success"
 *   * exitCode !== 0  → emits decision "failure" (or throws when onFailure="throw")
 *
 * Renderer-only — `runTerminalDockAction` reads from the renderer's
 * `useTerminalStore` + `PluginConsentBroker` singletons. Workflows
 * currently run in the renderer process; if/when V2 server-side
 * workflow execution lands, a Tauri command bridge for the broker
 * becomes necessary (scoped out of Wave 3, see ADR-0031).
 */

import { registerNodeExecutor } from "./registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

interface TerminalParams {
  command?: string
  args?: string[]
  cwd?: string
  shell?: string
  projectId?: string
  tabId?: string
  timeoutSec?: number
  onFailure?: "throw" | "branch"
  /**
   * Unattended mode: run headlessly (no dock tab, no consent prompt)
   * through the `runHeadlessExec` policy layer — master switch +
   * classifyCommand verdict + ask-policy. Default false (dock path).
   */
  unattended?: boolean
  onAskVerdict?: "fail" | "consent" | "run"
}

registerNodeExecutor({
  kind: "action.system.terminal",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as TerminalParams
    const command = (params.command ?? "").trim()
    if (!command) {
      throw nonRetryable("action.system.terminal requires a non-empty 'command'")
    }
    // Compose the final command line. `args` are appended verbatim — the
    // tab's shell will tokenize them when it sees the line.
    const composed =
      Array.isArray(params.args) && params.args.length > 0
        ? `${command} ${params.args.join(" ")}`
        : command

    const timeoutSec = clampTimeout(params.timeoutSec)

    // Unattended mode — headless policy layer instead of the dock.
    if (params.unattended === true) {
      const { runHeadlessExec } = await import("@/lib/terminal/headless-exec")
      const result = await runHeadlessExec({
        command: composed,
        cwd: params.cwd,
        shell: params.shell,
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
        onAskVerdict: params.onAskVerdict,
        chatSessionId: ctx.runId,
        runId: ctx.runId,
        source: "workflow",
      })
      if (!result.ok) {
        throw nonRetryable(`action.system.terminal: ${result.reason}`)
      }
      const success = !result.timedOut && result.exitCode === 0
      const decision = success ? "success" : "failure"
      if (!success && (params.onFailure ?? "throw") === "throw") {
        throw nonRetryable(
          result.timedOut
            ? "action.system.terminal: command timed out"
            : `action.system.terminal: command exited with code ${result.exitCode ?? "null"}`
        )
      }
      return {
        output: {
          exitCode: result.exitCode,
          output: result.output,
          command: composed,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        },
        decision,
        logs: [
          {
            level: success ? ("info" as const) : ("warn" as const),
            message: success
              ? `terminal command succeeded (exit ${result.exitCode})`
              : result.timedOut
                ? "terminal command timed out"
                : `terminal command failed (exit ${result.exitCode ?? "null"})`,
          },
        ],
      }
    }

    // Lazy-import to avoid pulling the renderer-only store graph into
    // any environment that doesn't actually run this node (tests for
    // unrelated executors, server-side validators, etc.).
    const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")

    const result = await runTerminalDockAction({
      // Workflow execution is identified by its `runId` — we scope the
      // agent-trust grant to that so each run gets its own consent
      // prompt (or reuses an existing session grant for the tab).
      chatSessionId: ctx.runId,
      action: params.tabId ? "write" : "spawn",
      args: {
        command: composed,
        cwd: params.cwd,
        shell: params.shell,
        projectId: params.projectId,
        tabId: params.tabId,
        timeoutSec,
      },
    })

    if (!result.ok) {
      // Structured error — surface as a non-retryable workflow failure.
      throw nonRetryable(`action.system.terminal: ${result.reason}`)
    }

    // The spawn / write branches return a session payload; read_recent /
    // wait_for_exit return a records list. We only invoke spawn/write
    // here so the records branch is unreachable, but narrow defensively.
    if ("records" in result) {
      return {
        output: { records: result.records },
        decision: "success",
      }
    }

    const exitCode = result.exitCode ?? null
    const success = exitCode === 0
    const decision = success ? "success" : "failure"
    if (!success && (params.onFailure ?? "throw") === "throw") {
      throw nonRetryable(`action.system.terminal: command exited with code ${exitCode ?? "null"}`)
    }

    return {
      output: {
        exitCode,
        output: result.output ?? "",
        sessionId: result.sessionId,
        command: composed,
      },
      decision,
      logs: [
        {
          level: success ? "info" : "warn",
          message: success
            ? `terminal command succeeded (exit ${exitCode})`
            : `terminal command failed (exit ${exitCode ?? "null"})`,
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
