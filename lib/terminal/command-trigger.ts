"use client"

/**
 * `trigger.terminal.command` fan-out — fired from the dock's command_end
 * wiring (`spawn-orchestrator.ts:wireSessionToStore`) so a finished shell
 * command can start workflows (mirrors `lib/goal/completion-linkage.ts`).
 *
 * Safety gates, in order:
 *   1. **Loop prevention** — only *user-spawned* tabs dispatch. Tabs
 *      spawned by an agent or a workflow run carry `agentSpawner`; firing
 *      on those would let a workflow's own terminal output re-trigger it.
 *   2. Blank commands (bare Enter at the prompt) never dispatch.
 *   3. **PII red-line** — the command line is only forwarded when
 *      `hasNoLeakingPii` passes; otherwise the payload (and substring
 *      matching) sees an empty string, so a secret-bearing line can match
 *      only an unscoped `commandContains`-less trigger and never leaks
 *      into run records or downstream LLM nodes.
 *
 * Best-effort and never throws into the terminal path — workflow failures
 * must not break the PTY event loop.
 */

export interface TerminalCommandEndEvent {
  sessionId: string
  projectId: string | null
  /** Chat/run identity that spawned the tab; `null` for user-spawned tabs. */
  agentSpawner: string | null
  /** Captured command line (may contain secrets — gated before dispatch). */
  command: string
  exitCode: number | null
  endedAt: number
}

/** Fan a finished dock command out to subscribed workflows. */
export async function dispatchTerminalCommandTriggers(
  event: TerminalCommandEndEvent
): Promise<void> {
  // Gate 1 — agent/workflow-spawned tabs never dispatch (self-trigger loop).
  if (event.agentSpawner !== null) return
  // Gate 2 — bare Enter / unparsed lines.
  const command = event.command.trim()
  if (command.length === 0) return

  try {
    // Lazy-load the workflow runtime + redaction gate so the terminal
    // subsystem stays cheap to import (matches dispatchGoalCompletedTriggers).
    const [{ dispatchTrigger }, { findMatchingWorkflows }, { hasNoLeakingPii }] = await Promise.all(
      [
        import("@/lib/workflow/runtime/trigger-bridge"),
        import("@/lib/workflow/runtime/trigger-subscriptions"),
        import("@/lib/twin/ingest/redact"),
      ]
    )

    // Gate 3 — PII red-line on the command text.
    const safeCommand = hasNoLeakingPii(command) ? command : ""
    const status = event.exitCode === 0 ? "success" : "failure"

    const matches = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: event.sessionId,
      projectId: event.projectId ?? undefined,
      status,
      command: safeCommand,
    })
    if (matches.length === 0) return

    await Promise.all(
      matches.map((match) =>
        dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.terminal.command",
          payload: {
            sessionId: event.sessionId,
            projectId: event.projectId,
            command: safeCommand,
            exitCode: event.exitCode,
            status,
            endedAt: event.endedAt,
          },
          originAt: event.endedAt,
          binding: { sessionId: event.sessionId },
        }).catch(() => {
          // Per-match isolation — one bad workflow can't block the others.
        })
      )
    )
  } catch {
    // Workflow runtime unavailable (e.g. early boot) — best-effort.
  }
}
