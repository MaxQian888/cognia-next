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

import { registerNodeExecutor } from "../registry"
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

// ── action.terminal.readRecent ──────────────────────────────────────────────
// Dock parity for the `read_recent` terminal_dock_* action: surface a tab's
// recent-commands ring (cmd / exitCode / endedAt) to downstream nodes — e.g.
// to feed an AI summarization step. Same `exposeDockToAgents` gate as the
// agent's MCP tool; no consent prompt (nothing is written to the PTY).
registerNodeExecutor({
  kind: "action.terminal.readRecent",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as { tabId?: string; lineLimit?: number }
    const tabId = (params.tabId ?? "").trim()
    if (!tabId) {
      throw nonRetryable("action.terminal.readRecent requires a non-empty 'tabId'")
    }
    const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
    const result = await runTerminalDockAction({
      chatSessionId: ctx.runId,
      action: "read_recent",
      args: { tabId, lineLimit: params.lineLimit },
    })
    if (!result.ok) {
      throw nonRetryable(`action.terminal.readRecent: ${result.reason}`)
    }
    if (!("records" in result)) {
      throw nonRetryable("action.terminal.readRecent: unexpected dock result shape")
    }
    return {
      output: { tabId, records: result.records, count: result.records.length },
      decision: "success",
    }
  },
})

// ── action.terminal.waitForExit ─────────────────────────────────────────────
// Dock parity for the `wait_for_exit` terminal_dock_* action: block until the
// next OSC 633 command_end in the tab, then route on its exit code. Pairs
// with a long-running command started elsewhere (user-typed, or a dock tab
// the run opened). Consent is requested by the dock handler itself.
registerNodeExecutor({
  kind: "action.terminal.waitForExit",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as {
      tabId?: string
      timeoutSec?: number
      onFailure?: "throw" | "branch"
    }
    const tabId = (params.tabId ?? "").trim()
    if (!tabId) {
      throw nonRetryable("action.terminal.waitForExit requires a non-empty 'tabId'")
    }
    const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
    const result = await runTerminalDockAction({
      chatSessionId: ctx.runId,
      action: "wait_for_exit",
      args: { tabId, timeoutSec: clampTimeout(params.timeoutSec) },
    })
    if (!result.ok) {
      throw nonRetryable(`action.terminal.waitForExit: ${result.reason}`)
    }
    if ("records" in result) {
      throw nonRetryable("action.terminal.waitForExit: unexpected dock result shape")
    }
    const exitCode = result.exitCode ?? null
    const success = exitCode === 0
    const decision = success ? "success" : "failure"
    if (!success && (params.onFailure ?? "throw") === "throw") {
      throw nonRetryable(
        `action.terminal.waitForExit: command exited with code ${exitCode ?? "null"}`
      )
    }
    return {
      output: { exitCode, sessionId: result.sessionId, command: result.output ?? "" },
      decision,
      logs: [
        {
          level: success ? ("info" as const) : ("warn" as const),
          message: success
            ? `terminal command finished (exit ${exitCode})`
            : `terminal command failed (exit ${exitCode ?? "null"})`,
        },
      ],
    }
  },
})

// ── trigger.terminal.command ────────────────────────────────────────────────
// Triggers are fired via the TS hook in `lib/terminal/command-trigger.ts`
// (command_end fan-out), not executed inline. This handler exists so the node
// round-trips when a workflow runs manually — it passes the trigger payload
// through (mirrors `trigger.desktop.event` in ../automation/desktop.ts).
registerNodeExecutor({
  kind: "trigger.terminal.command",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    return { output: { firedAt: ctx.trigger.originAt, payload: ctx.trigger.payload } }
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
