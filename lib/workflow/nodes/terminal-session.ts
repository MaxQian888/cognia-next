/**
 * Workflow executors for the persistent terminal-session nodes:
 *
 *   action.terminal.session.open   — open a session, output { sessionId }
 *   action.terminal.session.run    — run one command in it, wait for the
 *                                    OSC 633 command end, output
 *                                    { exitCode, output, durationMs }
 *   action.terminal.session.close  — close it early (otherwise the
 *                                    orchestrator's run-resource cleanup
 *                                    closes leftovers when the run ends)
 *
 * Two modes, chosen at `open`:
 *   * dock (default)        — a visible dock tab via the same consent
 *     gate as `action.system.terminal` (`runTerminalDockAction`).
 *   * unattended: true      — a private headless PTY (Rust backend);
 *     every `run` is gated through the `runHeadlessExec` policy layer
 *     (classifyCommand verdict + ask-policy), no human consent.
 *
 * Sessions are registered per run (`headless-session-registry`) so the
 * orchestrator deterministically closes whatever a run leaves open.
 */

import { registerNodeExecutor } from "./registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

interface OpenParams {
  cwd?: string
  shell?: string
  projectId?: string
  unattended?: boolean
}

interface RunParams {
  sessionId?: string
  command?: string
  args?: string[]
  timeoutSec?: number
  onFailure?: "throw" | "branch"
  onAskVerdict?: "fail" | "consent" | "run"
}

interface CloseParams {
  sessionId?: string
}

registerNodeExecutor({
  kind: "action.terminal.session.open",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as OpenParams
    const unattended = params.unattended === true
    const { registerRunSession } = await import("@/lib/terminal/headless-session-registry")

    if (unattended) {
      const { useSettingsStore } = await import("@/stores/settings")
      if (useSettingsStore.getState().settings?.terminal?.allowUnattendedExecution !== true) {
        throw nonRetryable(
          "action.terminal.session.open: unattended terminal execution is disabled " +
            "(settings.terminal.allowUnattendedExecution)"
        )
      }
      const { isTauri } = await import("@/lib/tauri")
      if (!isTauri()) {
        throw nonRetryable(
          "action.terminal.session.open: unattended sessions require the desktop app"
        )
      }
      const { invoke } = await import("@tauri-apps/api/core")
      const spawned = (await invoke("terminal_headless_spawn", {
        cwd: params.cwd,
        shell: params.shell,
      })) as { sessionId: string; shell: string }
      registerRunSession(ctx.runId, spawned.sessionId, "headless")
      return {
        output: { sessionId: spawned.sessionId, shell: spawned.shell, mode: "headless" },
        decision: "success",
      }
    }

    const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
    const result = await runTerminalDockAction({
      chatSessionId: ctx.runId,
      action: "spawn",
      args: {
        cwd: params.cwd,
        shell: params.shell,
        projectId: params.projectId,
      },
    })
    if (!result.ok) {
      throw nonRetryable(`action.terminal.session.open: ${result.reason}`)
    }
    if ("records" in result) {
      throw nonRetryable("action.terminal.session.open: unexpected dock result shape")
    }
    registerRunSession(ctx.runId, result.sessionId, "dock")
    return {
      output: { sessionId: result.sessionId, mode: "dock" },
      decision: "success",
    }
  },
})

registerNodeExecutor({
  kind: "action.terminal.session.run",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as RunParams
    const sessionId = (params.sessionId ?? "").trim()
    const command = (params.command ?? "").trim()
    if (!sessionId) {
      throw nonRetryable("action.terminal.session.run requires 'sessionId'")
    }
    if (!command) {
      throw nonRetryable("action.terminal.session.run requires a non-empty 'command'")
    }
    const composed =
      Array.isArray(params.args) && params.args.length > 0
        ? `${command} ${params.args.join(" ")}`
        : command
    const timeoutSec = clampTimeout(params.timeoutSec)

    const { listRunSessions } = await import("@/lib/terminal/headless-session-registry")
    const entry = listRunSessions(ctx.runId).find((e) => e.sessionId === sessionId)
    if (!entry) {
      throw nonRetryable(
        `action.terminal.session.run: session ${sessionId} was not opened by this run`
      )
    }

    let exitCode: number | null
    let output: string
    let durationMs = 0
    let timedOut = false

    if (entry.mode === "headless") {
      const { runHeadlessExec } = await import("@/lib/terminal/headless-exec")
      const result = await runHeadlessExec({
        command: composed,
        sessionId,
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
        onAskVerdict: params.onAskVerdict,
        chatSessionId: ctx.runId,
        runId: ctx.runId,
        source: "workflow",
      })
      if (!result.ok) {
        throw nonRetryable(`action.terminal.session.run: ${result.reason}`)
      }
      exitCode = result.exitCode
      output = result.output
      durationMs = result.durationMs
      timedOut = result.timedOut
    } else {
      const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
      const result = await runTerminalDockAction({
        chatSessionId: ctx.runId,
        action: "write",
        args: { tabId: sessionId, command: composed, timeoutSec },
      })
      if (!result.ok) {
        throw nonRetryable(`action.terminal.session.run: ${result.reason}`)
      }
      if ("records" in result) {
        throw nonRetryable("action.terminal.session.run: unexpected dock result shape")
      }
      exitCode = result.exitCode ?? null
      output = result.output ?? ""
    }

    const success = !timedOut && exitCode === 0
    const decision = success ? "success" : "failure"
    if (!success && (params.onFailure ?? "throw") === "throw") {
      throw nonRetryable(
        timedOut
          ? "action.terminal.session.run: command timed out"
          : `action.terminal.session.run: command exited with code ${exitCode ?? "null"}`
      )
    }
    return {
      output: { exitCode, output, sessionId, command: composed, durationMs, timedOut },
      decision,
      logs: [
        {
          level: success ? ("info" as const) : ("warn" as const),
          message: success
            ? `terminal command succeeded (exit ${exitCode})`
            : timedOut
              ? "terminal command timed out"
              : `terminal command failed (exit ${exitCode ?? "null"})`,
        },
      ],
    }
  },
})

registerNodeExecutor({
  kind: "action.terminal.session.close",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params as CloseParams
    const sessionId = (params.sessionId ?? "").trim()
    if (!sessionId) {
      throw nonRetryable("action.terminal.session.close requires 'sessionId'")
    }
    const { listRunSessions, deregisterRunSession } =
      await import("@/lib/terminal/headless-session-registry")
    const entry = listRunSessions(ctx.runId).find((e) => e.sessionId === sessionId)
    if (!entry) {
      // Closing an unknown / already-closed session is a no-op, not an
      // error — the orchestrator cleanup may have raced an explicit close.
      return { output: { sessionId, closed: false }, decision: "success" }
    }

    if (entry.mode === "headless") {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("terminal_headless_kill", { sessionId })
    } else {
      const [{ killFromDock }, { useTerminalStore }] = await Promise.all([
        import("@/lib/terminal/spawn-orchestrator"),
        import("@/stores/terminal/terminal-store"),
      ])
      await killFromDock(sessionId, useTerminalStore.getState())
    }
    deregisterRunSession(ctx.runId, sessionId)
    return { output: { sessionId, closed: true }, decision: "success" }
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
